import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult, findIssue, findTeamByKey } from './read';
import { PlatformActionCode, PlatformActionResponse } from '../../common/platform-actions/interfaces';
import { ClaimNextIssueAction } from '../../actions/issues/claim-next-issue';
import { ClaimIssueAction } from '../../actions/issues/claim-issue';
import { ReleaseIssueAction } from '../../actions/issues/release-issue';
import { UpdateIssueAction } from '../../actions/issues/update-issue';
import { CreateIssueAction } from '../../actions/issues/create-issue';
import { CreateProjectAction } from '../../actions/projects/create-project';
import { CreateCommentAction } from '../../actions/comments/create-comment';

type WritableActionCode =
  | 'issues.claimNext'
  | 'issues.claim'
  | 'issues.release'
  | 'issues.update'
  | 'issues.create'
  | 'projects.create'
  | 'comments.create';

const ACTIONS: Record<WritableActionCode, new (request: any, callerUid?: string) => { run(): Promise<PlatformActionResponse> }> = {
  'issues.claimNext': ClaimNextIssueAction,
  'issues.claim': ClaimIssueAction,
  'issues.release': ReleaseIssueAction,
  'issues.update': UpdateIssueAction,
  'issues.create': CreateIssueAction,
  'projects.create': CreateProjectAction,
  'comments.create': CreateCommentAction,
};

/**
 * Runs a Platform Action directly (bypassing the `pulsePlatformAction`
 * callable, which requires a Firebase `request.auth` context that an API-key
 * request doesn't have). `actorUid` is `principal.agentId ?? principal.createdBy`
 * — the agent's own `members/{workspaceId}_{agentId}` doc (or the human who
 * created the key, for a personal key) is what `isWorkspaceMember()` checks
 * against in each action's `authorize()`.
 */
async function runAction(actionCode: WritableActionCode, data: Record<string, any>, actorUid: string) {
  const ActionClass = ACTIONS[actionCode];
  const res = await new ActionClass({ actionCode, data } satisfies { actionCode: PlatformActionCode; data: Record<string, any> }, actorUid).run();
  return textResult(res.success ? res.data : { error: res.error });
}

export function registerWriteTools(server: McpServer, principal: McpPrincipal) {
  const actorUid = principal.agentId ?? principal.createdBy;

  server.tool(
    'pulse_next_task',
    'Atomically claims the next workable issue for the calling agent: assigned to it, or unassigned with the "ai-ready" label. Ordered by priority then age. Use dryRun to preview without claiming.',
    { dryRun: z.boolean().optional().default(false) },
    async ({ dryRun }) => runAction('issues.claimNext', { workspaceId: principal.workspaceId, dryRun }, actorUid)
  );

  server.tool(
    'pulse_claim_issue',
    'Claims a specific issue by identifier (e.g. "ENG-142"), assigning it to the calling agent and moving it to in_progress.',
    { identifier: z.string() },
    async ({ identifier }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('issues.claim', { id: doc.id }, actorUid);
    }
  );

  server.tool(
    'pulse_release_issue',
    'Releases an issue the calling agent previously claimed: unassigns it, reverts to todo if it was in_progress, and clears the agent claim.',
    { identifier: z.string(), reason: z.string().optional() },
    async ({ identifier, reason }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('issues.release', { id: doc.id, reason }, actorUid);
    }
  );

  server.tool(
    'pulse_update_issue',
    'Updates fields on an existing issue (not status — use pulse_update_issue_status for that).',
    {
      identifier: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      labelIds: z.array(z.string()).optional(),
      projectId: z.string().optional(),
      estimate: z.number().optional(),
      dueDate: z.string().optional(),
    },
    async ({ identifier, ...updates }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('issues.update', { id: doc.id, ...updates }, actorUid);
    }
  );

  server.tool(
    'pulse_update_issue_status',
    'Moves an issue to a new status.',
    {
      identifier: z.string(),
      status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']),
    },
    async ({ identifier, status }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('issues.update', { id: doc.id, status }, actorUid);
    }
  );

  server.tool(
    'pulse_create_issue',
    'Creates a new issue in the given team.',
    {
      teamKey: z.string().describe('Team key, e.g. "ENG".'),
      title: z.string(),
      description: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      labelIds: z.array(z.string()).optional(),
      projectId: z.string().optional(),
    },
    async ({ teamKey, ...rest }) => {
      const team = await findTeamByKey(principal.workspaceId, teamKey);
      if (!team) return textResult({ error: `No team found with key '${teamKey}'.` });
      return runAction(
        'issues.create',
        { workspaceId: principal.workspaceId, teamId: team.id, teamKey: team.data().key, ...rest },
        actorUid
      );
    }
  );

  server.tool(
    'pulse_create_project',
    'Creates a new project in the given team.',
    {
      teamKey: z.string(),
      name: z.string(),
      description: z.string().optional(),
      status: z.enum(['planned', 'in_progress', 'paused', 'completed', 'canceled']).optional(),
      color: z.string().optional(),
      targetDate: z.string().optional(),
    },
    async ({ teamKey, ...rest }) => {
      const team = await findTeamByKey(principal.workspaceId, teamKey);
      if (!team) return textResult({ error: `No team found with key '${teamKey}'.` });
      return runAction('projects.create', { workspaceId: principal.workspaceId, teamId: team.id, ...rest }, actorUid);
    }
  );

  server.tool(
    'pulse_comment_issue',
    'Adds a comment to an issue.',
    { identifier: z.string(), body: z.string() },
    async ({ identifier, body }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('comments.create', { issueId: doc.id, body, source: 'mcp' }, actorUid);
    }
  );

  server.registerPrompt(
    'pulse_work_on_next',
    {
      title: 'Work on next Pulse task',
      description: 'Claims the next workable issue and walks through the full claim -> branch -> code -> PR -> in_review flow.',
    },
    async () => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text:
              'Call pulse_next_task to claim the next workable issue. If found, read its description ' +
              'and comments, create the suggested branch, implement the change, commit, push, open a PR, ' +
              'link it with pulse_link_pr (once available), post progress with pulse_comment_issue, and ' +
              'move the issue to in_review with pulse_update_issue_status once the PR is ready for review. ' +
              'If nothing is found, say so and stop.',
          },
        },
      ],
    })
  );

  server.registerResource(
    'pulse-workspace-conventions',
    'pulse://workspace/conventions',
    { title: 'Pulse workspace conventions', mimeType: 'text/plain' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/plain',
          text: [
            'Branch naming: pul/<identifier-lowercase>-<slug-of-title>, e.g. pul/eng-142-fix-login-bug.',
            'Commit messages: short imperative summary, no scope prefix required.',
            'Valid issue statuses: backlog, todo, in_progress, in_review, done, canceled.',
            'Valid priorities: 0 (none), 1 (urgent), 2 (high), 3 (medium), 4 (low).',
          ].join('\n'),
        },
      ],
    })
  );
}
