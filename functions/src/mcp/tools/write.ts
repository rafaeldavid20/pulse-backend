import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult, findIssue, findTeamByKey } from './read';
import { PlatformActionCode, PlatformActionResponse } from '../../common/platform-actions/interfaces';
import { ClaimNextIssueAction } from '../../actions/issues/claim-next-issue';
import { ClaimIssueAction } from '../../actions/issues/claim-issue';
import { ReleaseIssueAction } from '../../actions/issues/release-issue';
import { RequestRepoWorkAction } from '../../actions/issues/request-repo-work';
import { UpdateIssueAction } from '../../actions/issues/update-issue';
import { CreateIssueAction } from '../../actions/issues/create-issue';
import { ReparentIssueAction } from '../../actions/issues/reparent-issue';
import { CreateProjectAction } from '../../actions/projects/create-project';
import { CreateCommentAction } from '../../actions/comments/create-comment';
import { CreateBranchAction } from '../../actions/github/create-branch';
import { LinkPrAction } from '../../actions/github/link-pr';
import { CreateLabelAction } from '../../actions/labels/create-label';
import { ReviewsStartAction } from '../../actions/reviews/start-review';
import { ReviewsSubmitAction } from '../../actions/reviews/submit-review';
import { ResolveFindingAction } from '../../actions/reviews/resolve-finding';
import { ReportCriteriaAction } from '../../actions/reviews/report-criteria';
import { ReportReviewIncompleteAction } from '../../actions/reviews/report-review-incomplete';
import { CompleteRunAction } from '../../actions/runs/complete-run';

const acceptanceCriterionSchema = z.object({
  id: z.string().optional().describe('Omitilo para que el servidor le asigne un id estable nuevo.'),
  text: z.string(),
});

type WritableActionCode =
  | 'issues.claimNext'
  | 'issues.claim'
  | 'issues.release'
  | 'issues.requestRepoWork'
  | 'issues.update'
  | 'issues.create'
  | 'issues.reparent'
  | 'projects.create'
  | 'comments.create'
  | 'github.createBranch'
  | 'github.linkPr'
  | 'labels.create'
  | 'reviews.start'
  | 'reviews.submit'
  | 'reviews.resolveFinding'
  | 'reviews.reportCriteria'
  | 'reviews.reportIncomplete'
  | 'runs.complete';

const ACTIONS: Record<WritableActionCode, new (request: any, callerUid?: string) => { run(): Promise<PlatformActionResponse> }> = {
  'issues.claimNext': ClaimNextIssueAction,
  'issues.claim': ClaimIssueAction,
  'issues.release': ReleaseIssueAction,
  'issues.requestRepoWork': RequestRepoWorkAction,
  'issues.update': UpdateIssueAction,
  'issues.create': CreateIssueAction,
  'issues.reparent': ReparentIssueAction,
  'projects.create': CreateProjectAction,
  'comments.create': CreateCommentAction,
  'github.createBranch': CreateBranchAction,
  'github.linkPr': LinkPrAction,
  'labels.create': CreateLabelAction,
  'reviews.start': ReviewsStartAction,
  'reviews.submit': ReviewsSubmitAction,
  'reviews.resolveFinding': ResolveFindingAction,
  'reviews.reportCriteria': ReportCriteriaAction,
  'reviews.reportIncomplete': ReportReviewIncompleteAction,
  'runs.complete': CompleteRunAction,
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
      acceptanceCriteria: z.array(acceptanceCriterionSchema).optional()
        .describe('Full replacement of the acceptance criteria checklist. Include existing criteria (with their "id") to keep them — omitting one removes it.'),
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
      acceptanceCriteria: z.array(acceptanceCriterionSchema).optional()
        .describe('Acceptance criteria checklist. Without it, QA review (once wired up) can only opine, not verify.'),
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

  server.tool(
    'pulse_request_repo_work',
    'Registers work still missing in ANOTHER repo of the workspace, so a new run picks it up there. Use it when your change needs a counterpart in a different repo: this session can only push to its own, so do NOT create branches or PRs elsewhere. Records a structured handoff on the issue (plus a comment) and, when your run ends, a new run is dispatched to the target repo. Fails if the repo is not allowed for the issue or has no agent workflow connected.',
    {
      identifier: z.string(),
      repoFullName: z.string().describe('"owner/repo" where the work is missing.'),
      summary: z.string().describe('What still has to be done in that repo.'),
      done: z.string().optional().describe('What is already done here, as context for whoever continues.'),
      sourceRepoFullName: z.string().optional(),
      sourceBranch: z.string().optional(),
      sourcePrNumber: z.number().int().optional(),
    },
    async ({ identifier, ...rest }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('issues.requestRepoWork', { issueId: doc.id, ...rest }, actorUid);
    }
  );

  server.tool(
    'pulse_next_review',
    'For QA agents. Atomically claims the review that qa-dispatch assigned to this agent (an issue in in_review with review.dispatchedTo set to this agent), with a lock just like pulse_next_task. Returns found:false if nothing is waiting.',
    {},
    async () => runAction('reviews.start', { workspaceId: principal.workspaceId }, actorUid)
  );

  server.tool(
    'pulse_submit_review',
    'For QA agents. Submits a review verdict for an issue currently claimed via pulse_next_review. The server computes the outcome from findings/criteriaResults (it does not trust a caller-supplied decision): any open blocker/major finding or a failed criterion rejects it (changes_requested, or needs_human once maxReviewAttempts is reached); an unverifiable-only criterion goes to needs_human; otherwise approved. Always check the project\'s Definition of Done from pulse_get_review_context too, even if the issue does not mention it — a violation is a finding with the DoD item\'s own severity, referencing dodId instead of criterionId. Writes the review, posts a summary comment on the issue, and publishes a COMMENT review (never APPROVE) on each PR with findings inline at file:line. Fails if the calling agent is not role "qa", or is the issue\'s own assignee. If this QA agent is in shadow mode (Agent.qaMode, default until a human switches it to enforce in Settings), the verdict is recorded in full but does not change the issue\'s status, assignee, or labels, and does not trigger rework — the human flow keeps going untouched. The response\'s `qaMode` field says which mode applied.',
    {
      identifier: z.string(),
      verdict: z.string().describe('Natural-language summary of the verdict, for humans.'),
      findings: z.array(z.object({
        severity: z.enum(['blocker', 'major', 'minor', 'nit']),
        message: z.string(),
        criterionId: z.string().optional().describe('References an AcceptanceCriterion.id from the issue.'),
        dodId: z.string().optional().describe('References a DefinitionOfDoneCriterion.id from the project, for a DoD violation instead of an acceptance criterion.'),
        repoFullName: z.string().optional().describe('Only needed for multi-repo issues.'),
        file: z.string().optional(),
        line: z.number().int().optional(),
      })).optional().default([]),
      criteriaResults: z.array(z.object({
        criterionId: z.string(),
        result: z.enum(['pass', 'fail', 'unverifiable']),
        evidence: z.string().optional(),
      })).optional().default([]),
    },
    async ({ identifier, ...rest }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('reviews.submit', { issueId: doc.id, ...rest }, actorUid);
    }
  );

  server.tool(
    'pulse_resolve_finding',
    'For dev agents doing rework after changes_requested. Marks a finding from the current review attempt as "fixed" (pushed a correction) or "disputed" (asks the QA of the next attempt to reconsider it instead of accepting it as-is).',
    {
      identifier: z.string(),
      findingId: z.string(),
      resolution: z.enum(['fixed', 'disputed']),
      note: z.string().optional().describe('Why: what changed, or why you disagree.'),
    },
    async ({ identifier, ...rest }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('reviews.resolveFinding', { issueId: doc.id, ...rest }, actorUid);
    }
  );

  server.tool(
    'pulse_report_criteria',
    'For dev agents, before opening a PR. Declares, criterion by criterion, whether the acceptance criteria were met ("met"/"not_met"/"unverifiable") with a line of evidence each — also cover every item in the project\'s Definition of Done (D14, from pulse_get_review_context), using its id as criterionId the same way. Full replacement of the checklist — the QA sees this in pulse_get_review_context as a claim to cross-check, not as ground truth. If any criterion is not_met, do not open the PR: comment and release, or flag ambiguity instead.',
    {
      identifier: z.string(),
      checks: z.array(z.object({
        criterionId: z.string().describe('An AcceptanceCriterion.id from the issue, or a DefinitionOfDoneCriterion.id from the project.'),
        result: z.enum(['met', 'not_met', 'unverifiable']),
        evidence: z.string().describe('File, command run, or output — concrete evidence, not a restatement of the criterion.'),
      })),
    },
    async ({ identifier, checks }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('reviews.reportCriteria', { issueId: doc.id, checks }, actorUid);
    }
  );

  server.tool(
    'pulse_report_review_incomplete',
    'For QA agents. Call this at the very end of a QA run regardless of outcome (the pulse-qa.yml report step does this, not the model directly in normal use). If the review was already closed by pulse_submit_review, this is a no-op. If it is still "running" (the session crashed, hit --max-turns, or otherwise ended without a verdict), it escalates the review to needs_human immediately instead of waiting for the review sweeper. Never releases or reassigns back to the dev — only a human or a fresh QA attempt moves it from here.',
    {
      identifier: z.string(),
      reason: z.string().optional().describe('Diagnostic for humans: what happened (errors, last tool calls, etc.).'),
    },
    async ({ identifier, reason }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      return runAction('reviews.reportIncomplete', { issueId: doc.id, reason }, actorUid);
    }
  );

  server.tool(
    'pulse_report_run',
    'Internal: called by the Pulse workflow report step (not by the model in normal use) to close out the agent_runs record this run\'s dispatch created — turns and costUsd read from the execution file\'s result message. Idempotent: completing an already-completed run is a no-op.',
    {
      runId: z.string(),
      outcome: z.enum(['pr_opened', 'verdict_submitted', 'released', 'ambiguous', 'failed', 'timeout']),
      turns: z.number().int().optional(),
      costUsd: z.number().optional(),
      runUrl: z.string().optional(),
    },
    async ({ runId, ...rest }) => runAction('runs.complete', { runId, ...rest }, actorUid)
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
