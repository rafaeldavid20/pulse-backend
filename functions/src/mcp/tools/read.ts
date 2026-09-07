import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import: this file is itself only reached via a lazy `await
// import('./tools/read')` from server.ts, so zod's cost is still paid only
// when an MCP request actually builds a server, not on every cold start.
// (Passing `z` in as a parameter instead — typed as `typeof import('zod')`
// — was tried first and triggered TS2589 "Type instantiation is
// excessively deep" on every non-empty inputSchema; a direct static import
// doesn't.)
import { z } from 'zod';
import { McpPrincipal } from '../auth';

export function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Resolves `ENG-142` -> its Firestore doc, or an `issue-xxxx` doc id directly. */
export async function findIssue(workspaceId: string, identifier: string) {
  const db = getFirestore();
  if (identifier.startsWith('issue-')) {
    const snap = await db.collection('issues').doc(identifier).get();
    if (snap.exists && snap.data()?.workspaceId === workspaceId) return snap;
    return null;
  }
  const q = await db
    .collection('issues')
    .where('workspaceId', '==', workspaceId)
    .where('identifier', '==', identifier.toUpperCase())
    .limit(1)
    .get();
  return q.empty ? null : q.docs[0];
}

/** Resolves a team key (e.g. "ENG") to its doc within the workspace, or null if none matches. */
export async function findTeamByKey(workspaceId: string, teamKey: string) {
  const db = getFirestore();
  const snap = await db
    .collection('teams')
    .where('workspaceId', '==', workspaceId)
    .where('key', '==', teamKey.toUpperCase())
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Registers the read-only tools. All of them resolve `workspaceId` from
 * `principal` (set by `authenticateRequest`) rather than accepting it as a
 * tool input — an agent cannot read another workspace's data by asking for
 * its id, because the tool never looks at anything the model could supply.
 */
export function registerReadTools(server: McpServer, principal: McpPrincipal) {
  const db = getFirestore();

  server.registerTool(
    'pulse_whoami',
    {
      title: 'Pulse whoami',
      description: "Returns the caller's resolved identity: workspace, agent id (if any), and granted scopes.",
      inputSchema: {},
    },
    async () => textResult({ workspaceId: principal.workspaceId, agentId: principal.agentId, scopes: principal.scopes })
  );

  server.registerTool(
    'pulse_list_teams',
    {
      title: 'List teams',
      description: 'Lists the teams in the caller’s workspace.',
      inputSchema: {},
    },
    async () => {
      const snap = await db.collection('teams').where('workspaceId', '==', principal.workspaceId).get();
      return textResult(snap.docs.map((d) => d.data()));
    }
  );

  // Using the legacy `tool()` overload (not `registerTool`) for the tools
  // below: `registerTool<OutputArgs, InputArgs>` leaves `OutputArgs`
  // unresolved when no `outputSchema` is given, and combined with a
  // non-empty `inputSchema` shape that triggers a "Type instantiation is
  // excessively deep" TS2589 under TS 5.9 + this SDK version. `tool()` has
  // a single, simpler type parameter and isn't affected.
  server.tool(
    'pulse_list_projects',
    'Lists projects in the workspace, optionally filtered by team key or status.',
    {
      teamKey: z.string().optional().describe('Team key, e.g. "ENG" — filters to that team’s projects.'),
      status: z
        .enum(['planned', 'in_progress', 'paused', 'completed', 'canceled'])
        .optional(),
    },
    async ({ teamKey, status }) => {
      let teamId: string | undefined;
      if (teamKey) {
        const teamSnap = await db
          .collection('teams')
          .where('workspaceId', '==', principal.workspaceId)
          .where('key', '==', teamKey.toUpperCase())
          .limit(1)
          .get();
        if (teamSnap.empty) return textResult({ projects: [], note: `No team found with key '${teamKey}'.` });
        teamId = teamSnap.docs[0].id;
      }

      let query = db.collection('projects').where('workspaceId', '==', principal.workspaceId) as FirebaseFirestore.Query;
      if (teamId) query = query.where('teamId', '==', teamId);
      if (status) query = query.where('status', '==', status);

      const snap = await query.get();
      return textResult(snap.docs.map((d) => d.data()));
    }
  );

  server.tool(
    'pulse_list_issues',
    'Lists issues in the workspace with optional filters. Use assignee "me" for the caller agent’s own issues.',
    {
      assignee: z.string().optional().describe('"me", "unassigned", or a member/agent id.'),
      status: z.array(z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])).optional(),
      teamKey: z.string().optional(),
      projectId: z.string().optional(),
      labelIds: z.array(z.string()).optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async ({ assignee, status, teamKey, projectId, labelIds, search, limit }) => {
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
    'pulse_get_issue',
    'Fetches a single issue by identifier (e.g. "ENG-142") or doc id ("issue-xxxx").',
    { identifier: z.string() },
    async ({ identifier }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ found: false });
      return textResult({ found: true, issue: doc.data() });
    }
  );
}
