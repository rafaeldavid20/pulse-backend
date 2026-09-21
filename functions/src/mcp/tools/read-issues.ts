import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import por el mismo motivo que en `read.ts`/`write.ts`: ver el
// comentario de cabecera de `read.ts` sobre `zod`/TS2589 (este archivo solo se
// alcanza vía el `await import('./tools/read')` perezoso de `server.ts`).
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { getPullRequestDiff, listPullRequestFiles, REVIEW_DIFF_SIZE_CAP } from '../../github/client';
import { textResult, findIssue, findMembersByUserIds } from './read';

const DEFAULT_COMMENTS_LIMIT = 50;
const MAX_COMMENTS_LIMIT = 200;

export function registerIssueReadTools(server: McpServer, principal: McpPrincipal) {
  const db = getFirestore();

  server.tool(
    'pulse_list_issues',
    'Lists issues in the workspace with optional filters. Use assignee "me" for the caller agent’s own issues.',
    {
      assignee: z.string().optional().describe('"me", "unassigned", or a member/agent id.'),
      status: z.array(z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])).optional(),
      teamKey: z.string().optional(),
      projectId: z.string().optional(),
      labelIds: z.array(z.string()).optional(),
      type: z.array(z.enum(['epic', 'story', 'task', 'bug', 'subtask'])).optional()
        .describe('Filter by hierarchy level. Use ["epic"] to list only epics.'),
      epicId: z.string().optional()
        .describe('Only issues under this epic (identifier "ENG-12" or doc id). Does not include the epic itself.'),
      parentId: z.string().optional()
        .describe('Only direct children of this issue (identifier or doc id).'),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ assignee, status, teamKey, projectId, labelIds, type, epicId, parentId, search, limit }) => {
      let query = db.collection('issues').where('workspaceId', '==', principal.workspaceId) as FirebaseFirestore.Query;

      if (teamKey) {
        const teamSnap = await db
          .collection('teams')
          .where('workspaceId', '==', principal.workspaceId)
          .where('key', '==', teamKey.toUpperCase())
          .limit(1)
          .get();
        if (teamSnap.empty) return textResult({ issues: [], note: `No team found with key '${teamKey}'.` });
        query = query.where('teamId', '==', teamSnap.docs[0].id);
      }
      if (projectId) query = query.where('projectId', '==', projectId);

      // `epicId`/`parentId` aceptan identificador legible ("ENG-12") además del
      // doc id, igual que `pulse_get_issue` — un agente que leyó un issue tiene
      // el identificador a mano, no el `issue-xxxx`.
      if (epicId) {
        const epicDoc = await findIssue(principal.workspaceId, epicId);
        if (!epicDoc) return textResult({ issues: [], note: `No epic found for '${epicId}'.` });
        query = query.where('epicId', '==', epicDoc.id);
      }
      if (parentId) {
        const parentDoc = await findIssue(principal.workspaceId, parentId);
        if (!parentDoc) return textResult({ issues: [], note: `No issue found for '${parentId}'.` });
        query = query.where('parentId', '==', parentDoc.id);
      }

      if (assignee === 'me') {
        if (!principal.agentId) {
          return textResult({ issues: [], note: 'This API key is not associated with an agent — "me" has no meaning.' });
        }
        query = query.where('assigneeId', '==', principal.agentId);
      } else if (assignee === 'unassigned') {
        query = query.where('assigneeId', '==', null);
      } else if (assignee) {
        query = query.where('assigneeId', '==', assignee);
      }

      const snap = await query.limit(200).get();
      let issues = snap.docs.map((d) => d.data());

      // Filters that can't be expressed as Firestore equality/array-contains
      // without a composite index we don't have yet — applied in memory
      // against the (already workspace/team/project-scoped) result set.
      if (status && status.length > 0) issues = issues.filter((i) => status.includes(i.status));
      if (type && type.length > 0) issues = issues.filter((i) => type.includes(i.type ?? 'task'));
      if (labelIds && labelIds.length > 0) {
        issues = issues.filter((i) => Array.isArray(i.labelIds) && labelIds.some((l) => i.labelIds.includes(l)));
      }
      if (search) {
        const q = search.toLowerCase();
        issues = issues.filter(
          (i) => i.title?.toLowerCase().includes(q) || i.identifier?.toLowerCase().includes(q)
        );
      }

      issues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return textResult(issues.slice(0, limit));
    }
  );

  server.tool(
    'pulse_get_epic',
    'Fetches an epic with its full child tree and progress. One call instead of walking the hierarchy issue by issue.',
    { identifier: z.string().describe('Epic identifier ("ENG-12") or doc id ("issue-xxxx").') },
    async ({ identifier }) => {
      const epicDoc = await findIssue(principal.workspaceId, identifier);
      if (!epicDoc) return textResult({ found: false });

      const epic = epicDoc.data()!;
      if ((epic.type ?? 'task') !== 'epic') {
        return textResult({
          found: true,
          isEpic: false,
          note: `'${identifier}' is of type '${epic.type ?? 'task'}', not an epic. Use pulse_get_issue instead.`,
          issue: epic,
        });
      }

      // Un solo query por `epicId` trae el subárbol entero (el campo está
      // denormalizado justamente para esto), y el árbol se arma en memoria.
      const descendantsSnap = await db
        .collection('issues')
        .where('workspaceId', '==', principal.workspaceId)
        .where('epicId', '==', epicDoc.id)
        .get();
      const descendants = descendantsSnap.docs.map((d) => d.data());

      interface TreeNode extends FirebaseFirestore.DocumentData {
        children: TreeNode[];
      }
      const childrenOf = (parentId: string): TreeNode[] =>
        descendants
          .filter((i) => i.parentId === parentId)
          .map((i) => ({ ...i, children: childrenOf(i.id) }));

      const closed = new Set(['done', 'canceled']);
      return textResult({
        found: true,
        isEpic: true,
        epic,
        progress: {
          total: descendants.length,
          closed: descendants.filter((i) => closed.has(i.status)).length,
          byStatus: descendants.reduce<Record<string, number>>((acc, i) => {
            acc[i.status] = (acc[i.status] || 0) + 1;
            return acc;
          }, {}),
        },
        children: childrenOf(epicDoc.id),
      });
    }
  );

  server.tool(
    'pulse_get_issue',
    'Fetches a single issue by identifier (e.g. "ENG-142") or doc id ("issue-xxxx").',
    { identifier: z.string() },
    async ({ identifier }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ found: false });
      return textResult({ found: true, issue: doc.data() });
    }
  );

  server.tool(
    'pulse_list_comments',
    'Lists an issue’s comments in chronological order, with each author resolved to a display name (see pulse_list_members). Lighter than pulse_get_review_context: no diffs, no criteria, just the conversation — use this to catch up on an issue before starting it, e.g. to read a previous run’s report or the questions behind the "ambigua" label.',
    {
      identifier: z.string(),
      since: z.string().optional().describe('ISO timestamp — only comments created after this.'),
      limit: z.number().int().min(1).max(MAX_COMMENTS_LIMIT).default(DEFAULT_COMMENTS_LIMIT),
    },
    async ({ identifier, since, limit }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });

      let query = db
        .collection('comments')
        .where('workspaceId', '==', principal.workspaceId)
        .where('issueId', '==', doc.id) as FirebaseFirestore.Query;
      if (since) query = query.where('createdAt', '>', since);
      query = query.orderBy('createdAt', 'asc');

      // Se pide uno de más para saber si el resultado se truncó, sin otra
      // vuelta a Firestore — mismo truco que `pulse_get_review_context` no
      // necesita porque no pagina, pero que las listas nuevas sí (D22).
      const snap = await query.limit(limit + 1).get();
      const truncated = snap.docs.length > limit;
      const comments = snap.docs.slice(0, limit).map((d) => d.data());

      const membersByUserId = await findMembersByUserIds(principal.workspaceId, comments.map((c) => c.authorId));

      return textResult({
        comments: comments.map((c) => ({
          id: c.id,
          authorId: c.authorId,
          authorName: membersByUserId.get(c.authorId)?.displayName ?? c.authorId,
          body: c.body,
          source: c.source,
          createdAt: c.createdAt,
        })),
        ...(truncated
          ? { note: `Hay más comentarios de los que trae este límite (${limit}) — subí "limit" o usá "since" con el createdAt del último para paginar.` }
          : {}),
      });
    }
  );

  server.tool(
    'pulse_list_activity',
    'Lists an issue’s activity log: status changes, (re)assignment, label changes and similar structured events, oldest first.',
    { identifier: z.string() },
    async ({ identifier }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });

      // `Activity` no tiene `workspaceId` propio (ver domain.generated.ts): el
      // aislamiento por workspace ya lo dio `findIssue` de arriba al resolver
      // `doc.id` dentro del workspace del caller.
      const snap = await db.collection('activity').where('issueId', '==', doc.id).get();
      const activity = snap.docs.map((d) => d.data());
      activity.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return textResult({ activity });
    }
  );

  server.tool(
    'pulse_get_review_context',
    'For QA agents reviewing an issue, for dev agents doing rework after changes_requested (D9), and for dev agents self-checking before opening a PR (D13). Everything needed: the accepted acceptance criteria, the project\'s Definition of Done (D14 — rules that apply to every issue in the project, empty if the project has none), the dev\'s self-check, findings from previous attempts with their status, the issue\'s comments, and — for each PR in gitRefs — the diff (paginated, capped in size; past the cap you get the file list instead and read the rest from the checkout).',
    { identifier: z.string() },
    async ({ identifier }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      const issue = doc.data()!;

      const criteria = (issue.acceptanceCriteria || []).filter((c: any) => c.accepted !== false);

      const [commentsSnap, projectSnap] = await Promise.all([
        db.collection('comments').where('issueId', '==', doc.id).get(),
        issue.projectId ? db.collection('projects').doc(issue.projectId).get() : Promise.resolve(null),
      ]);
      const project: any = projectSnap?.exists ? projectSnap.data() : null;

      const refs: any[] =
        Array.isArray(issue.gitRefs) && issue.gitRefs.length > 0
          ? issue.gitRefs
          : issue.git?.repoFullName && issue.git?.prNumber !== undefined
            ? [issue.git]
            : [];

      let prs: Array<Record<string, any>> = [];
      if (refs.length > 0) {
        const installSnap = await db
          .collection('github_installations')
          .where('workspaceId', '==', principal.workspaceId)
          .limit(1)
          .get();
        if (installSnap.empty) {
          prs = refs.map((r) => ({ repoFullName: r.repoFullName, prNumber: r.prNumber, error: 'GitHub no está conectado en este workspace.' }));
        } else {
          const installationId = installSnap.docs[0].data().installationId;
          prs = await Promise.all(
            refs
              .filter((r) => r?.prNumber !== undefined)
              .map(async (r) => {
                try {
                  const diff = await getPullRequestDiff(installationId, r.repoFullName, r.prNumber);
                  if (diff.length <= REVIEW_DIFF_SIZE_CAP) {
                    return { repoFullName: r.repoFullName, prNumber: r.prNumber, diff };
                  }
                  const files = await listPullRequestFiles(installationId, r.repoFullName, r.prNumber);
                  return {
                    repoFullName: r.repoFullName,
                    prNumber: r.prNumber,
                    diffTooLarge: true,
                    note: `El diff supera ${REVIEW_DIFF_SIZE_CAP} caracteres — hacé checkout de la rama y leé estos archivos.`,
                    files,
                  };
                } catch (error: any) {
                  return { repoFullName: r.repoFullName, prNumber: r.prNumber, error: error?.message || String(error) };
                }
              })
          );
        }
      }

      const historyFindings = (issue.review?.history || []).map((h: any) => ({
        attempt: h.attempt,
        state: h.state,
        findings: h.findings || [],
      }));
      const currentFindings = issue.review?.findings
        ? [{ attempt: issue.review.attempt, state: issue.review.state, findings: issue.review.findings }]
        : [];

      return textResult({
        found: true,
        issue,
        criteria,
        definitionOfDone: project?.definitionOfDone || [],
        devSelfCheck: issue.devSelfCheck || [],
        previousFindings: [...historyFindings, ...currentFindings],
        comments: commentsSnap.docs.map((d) => d.data()),
        prs,
      });
    }
  );
}
