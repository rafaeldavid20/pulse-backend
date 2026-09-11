import { getFirestore } from 'firebase-admin/firestore';
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
import { ReparentIssueAction } from '../../actions/issues/reparent-issue';
import { CreateProjectAction } from '../../actions/projects/create-project';
import { CreateCommentAction } from '../../actions/comments/create-comment';
import { CreateBranchAction } from '../../actions/github/create-branch';
import { LinkPrAction } from '../../actions/github/link-pr';
import { CreateLabelAction } from '../../actions/labels/create-label';

type WritableActionCode =
  | 'issues.claimNext'
  | 'issues.claim'
  | 'issues.release'
  | 'issues.update'
  | 'issues.create'
  | 'issues.reparent'
  | 'projects.create'
  | 'comments.create'
  | 'github.createBranch'
  | 'github.linkPr'
  | 'labels.create';

const ACTIONS: Record<WritableActionCode, new (request: any, callerUid?: string) => { run(): Promise<PlatformActionResponse> }> = {
  'issues.claimNext': ClaimNextIssueAction,
  'issues.claim': ClaimIssueAction,
  'issues.release': ReleaseIssueAction,
  'issues.update': UpdateIssueAction,
  'issues.create': CreateIssueAction,
  'issues.reparent': ReparentIssueAction,
  'projects.create': CreateProjectAction,
  'comments.create': CreateCommentAction,
  'github.createBranch': CreateBranchAction,
  'github.linkPr': LinkPrAction,
  'labels.create': CreateLabelAction,
};

/**
 * Runs a Platform Action directly (bypassing the `pulsePlatformAction`
 * callable, which requires a Firebase `request.auth` context that an API-key
 * request doesn't have). `actorUid` is `principal.agentId ?? principal.createdBy`
 * — the agent's own `members/{workspaceId}_{agentId}` doc (or the human who
 * created the key, for a personal key) is what `isWorkspaceMember()` checks
 * against in each action's `authorize()`.
 */
/** Corre una Platform Action y devuelve la respuesta cruda (para orquestar varias). */
async function runRaw(actionCode: WritableActionCode, data: Record<string, any>, actorUid: string): Promise<PlatformActionResponse> {
  const ActionClass = ACTIONS[actionCode];
  return new ActionClass({ actionCode, data } satisfies { actionCode: PlatformActionCode; data: Record<string, any> }, actorUid).run();
}

async function runAction(actionCode: WritableActionCode, data: Record<string, any>, actorUid: string) {
  const res = await runRaw(actionCode, data, actorUid);
  return textResult(res.success ? res.data : { error: res.error });
}

/**
 * Etiqueta con la que el agente señala un issue que no puede implementar sin una
 * decisión de producto. Se busca por nombre y se crea si falta, así funciona en
 * cualquier workspace sin que el modelo tenga que conocer un id de etiqueta.
 */
const AMBIGUITY_LABEL = 'ambigua';
const AMBIGUITY_COLOR = '#F09436';

async function ensureAmbiguityLabel(workspaceId: string, teamId: string, actorUid: string): Promise<string | null> {
  const found = await getFirestore()
    .collection('labels')
    .where('workspaceId', '==', workspaceId)
    .where('name', '==', AMBIGUITY_LABEL)
    .limit(1)
    .get();
  if (!found.empty) return found.docs[0].id;
  const res = await runRaw('labels.create', { workspaceId, teamId, name: AMBIGUITY_LABEL, color: AMBIGUITY_COLOR }, actorUid);
  if (!res.success) return null;
  const d: any = res.data || {};
  return d.id || d.label?.id || null;
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
      repoFullName: z.string().optional()
        .describe('"owner/repo". Pass an empty string to clear it and go back to inheriting from the epic.'),
      assigneeId: z.string().nullable().optional()
        .describe('Member or agent id to assign. Pass null to unassign. Assigning an agent that has autonomousMode on, on an issue already in "todo", does NOT start it — the dispatch fires on entering "todo", so move it out and back in.'),
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
    'Creates a new issue in the given team. Set type "epic" to create an epic, and parent to hang a story under one.',
    {
      teamKey: z.string().describe('Team key, e.g. "ENG".'),
      title: z.string(),
      description: z.string().optional(),
      priority: z.number().int().min(0).max(4).optional(),
      labelIds: z.array(z.string()).optional(),
      projectId: z.string().optional(),
      type: z.enum(['epic', 'story', 'task', 'bug', 'subtask']).optional()
        .describe('Hierarchy level. Defaults to "task". Epics cannot have a parent; subtasks hang off a story/task/bug.'),
      parent: z.string().optional()
        .describe('Parent issue identifier ("ENG-12") or doc id. Must be a valid parent for this type.'),
      estimate: z.number().optional(),
      dueDate: z.string().optional(),
      repoFullName: z.string().optional()
        .describe('"owner/repo". On an epic it becomes the default for every issue under it; on an issue it overrides that default.'),
    },
    async ({ teamKey, parent, ...rest }) => {
      const team = await findTeamByKey(principal.workspaceId, teamKey);
      if (!team) return textResult({ error: `No team found with key '${teamKey}'.` });

      let parentId: string | undefined;
      if (parent) {
        const parentDoc = await findIssue(principal.workspaceId, parent);
        if (!parentDoc) return textResult({ error: `No parent issue found for '${parent}'.` });
        parentId = parentDoc.id;
      }

      return runAction(
        'issues.create',
        { workspaceId: principal.workspaceId, teamId: team.id, teamKey: team.data().key, parentId, ...rest },
        actorUid
      );
    }
  );

  server.tool(
    'pulse_move_issue',
    'Moves an issue under a different parent (or to the top level). Its own sub-issues move with it and inherit the new epic.',
    {
      identifier: z.string().describe('The issue to move ("ENG-45").'),
      parent: z.string().nullable()
        .describe('New parent identifier or doc id. Pass null to detach the issue from its current parent.'),
    },
    async ({ identifier, parent }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });

      let parentId: string | null = null;
      if (parent) {
        const parentDoc = await findIssue(principal.workspaceId, parent);
        if (!parentDoc) return textResult({ error: `No parent issue found for '${parent}'.` });
        parentId = parentDoc.id;
      }

      return runAction('issues.reparent', { id: doc.id, parentId }, actorUid);
    }
  );

  server.tool(
    'pulse_flag_ambiguity',
    'Flags an issue you cannot implement without a product decision: comments your concrete questions, adds the "ambigua" label and releases the issue, so the person managing it decides whether to clarify the description or authorize you to decide. Call it and then stop. Pass clear=true to remove the label once the comments answer the questions.',
    {
      identifier: z.string(),
      questions: z.array(z.string()).optional()
        .describe('Concrete questions the description, code and comments do not answer. Required unless clear is true.'),
      clear: z.boolean().optional().describe('Remove the "ambigua" label instead of flagging.'),
    },
    async ({ identifier, questions, clear }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      const issue = doc.data()!;
      const labelId = await ensureAmbiguityLabel(principal.workspaceId, issue.teamId, actorUid);
      if (!labelId) return textResult({ error: 'No se pudo obtener ni crear la etiqueta "ambigua".' });
      const current: string[] = Array.isArray(issue.labelIds) ? issue.labelIds : [];

      if (clear) {
        const res = await runRaw('issues.update', { id: doc.id, labelIds: current.filter((l) => l !== labelId) }, actorUid);
        return textResult(res.success ? { cleared: true } : { error: res.error });
      }

      if (!questions || questions.length === 0) {
        return textResult({ error: 'Pasá al menos una pregunta concreta en "questions".' });
      }

      // Etiqueta, comentario y liberación del lado servidor y en este orden: si
      // se lo pidiéramos al modelo como tres llamadas, podría quedar a medias.
      const labeled = await runRaw('issues.update', { id: doc.id, labelIds: [...new Set([...current, labelId])] }, actorUid);
      if (!labeled.success) return textResult({ error: labeled.error });

      const body = [
        '**El agente marcó este issue como ambiguo.** Antes de implementar necesita que se resuelva:',
        '',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        'Para seguir: completá la descripción, o respondé acá (por ejemplo "decidí vos"), y volvé a asignar el issue al agente. En el próximo run va a leer estos comentarios.',
      ].join('\n');
      await runRaw('comments.create', { issueId: doc.id, body, source: 'mcp' }, actorUid);

      const released = await runRaw('issues.release', {
        id: doc.id,
        reason: 'Marcado como ambiguo por el agente: ver las preguntas en los comentarios.',
      }, actorUid);
      return textResult({ flagged: true, released: released.success, labelId });
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

  server.tool(
    'pulse_create_branch',
    'Creates a git branch for an issue in the workspace\'s connected GitHub repo, off the repo\'s default branch. Uses the naming convention pul/<identifier>-<slug> when no branch name is given.',
    {
      identifier: z.string(),
      repoFullName: z.string().optional().describe('"owner/repo" — required only if more than one repo is connected.'),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
    },
    async ({ identifier, ...rest }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('github.createBranch', { issueId: doc.id, ...rest }, actorUid);
    }
  );

  server.tool(
    'pulse_link_pr',
    'Records a pull request (number, URL, state) against an issue.',
    {
      identifier: z.string(),
      prNumber: z.number().int(),
      prUrl: z.string(),
      prState: z.enum(['open', 'draft', 'merged', 'closed']).optional(),
    },
    async ({ identifier, ...rest }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('github.linkPr', { issueId: doc.id, ...rest }, actorUid);
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
