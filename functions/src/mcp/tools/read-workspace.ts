import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult, findTeamByKey } from './read';

export function registerWorkspaceReadTools(server: McpServer, principal: McpPrincipal) {
  const db = getFirestore();

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
    'pulse_get_project',
    'Fetches a single project by id, including its Definition of Done (D14) and repoFullNames — without going through pulse_get_review_context.',
    { projectId: z.string() },
    async ({ projectId }) => {
      const snap = await db.collection('projects').doc(projectId).get();
      if (!snap.exists || snap.data()?.workspaceId !== principal.workspaceId) return textResult({ found: false });
      return textResult({ found: true, project: snap.data() });
    }
  );

  server.tool(
    'pulse_list_labels',
    'Lists the workspace’s labels — resolves the ids in an issue’s labelIds to a name and color. Optionally filter by team key.',
    { teamKey: z.string().optional() },
    async ({ teamKey }) => {
      let teamId: string | undefined;
      if (teamKey) {
        const teamDoc = await findTeamByKey(principal.workspaceId, teamKey);
        if (!teamDoc) return textResult({ labels: [], note: `No team found with key '${teamKey}'.` });
        teamId = teamDoc.id;
      }

      let query = db.collection('labels').where('workspaceId', '==', principal.workspaceId) as FirebaseFirestore.Query;
      if (teamId) query = query.where('teamId', '==', teamId);

      const snap = await query.get();
      return textResult(snap.docs.map((d) => d.data()));
    }
  );

  server.tool(
    'pulse_list_members',
    'Lists the workspace’s members (humans and agent mirrors), for resolving an issue’s assigneeId/creatorId/updatedBy — or a comment’s authorId — to a display name, and for picking who to assign an issue to.',
    {},
    async () => {
      const snap = await db.collection('members').where('workspaceId', '==', principal.workspaceId).get();
      return textResult(snap.docs.map((d) => d.data()));
    }
  );

  server.tool(
    'pulse_list_agents',
    'Lists the workspace’s agents (role, kind, autonomousMode, maxConcurrentIssues, qaMode, connected repos) — for picking which agent to assign an issue to, or for diagnosing why an issue didn’t dispatch.',
    {},
    async () => {
      const snap = await db.collection('agents').where('workspaceId', '==', principal.workspaceId).get();
      return textResult(snap.docs.map((d) => d.data()));
    }
  );

  server.tool(
    'pulse_list_cycles',
    'Lists the workspace’s cycles, optionally filtered by team key or status.',
    {
      teamKey: z.string().optional(),
      status: z.enum(['upcoming', 'active', 'completed']).optional(),
    },
    async ({ teamKey, status }) => {
      let teamId: string | undefined;
      if (teamKey) {
        const teamDoc = await findTeamByKey(principal.workspaceId, teamKey);
        if (!teamDoc) return textResult({ cycles: [], note: `No team found with key '${teamKey}'.` });
        teamId = teamDoc.id;
      }

      // Un solo filtro de igualdad (`workspaceId`): el resto se aplica en
      // memoria para no necesitar un índice compuesto nuevo (el que ya existe
      // para `cycles` es `teamId + status + startsAt`, sin `workspaceId`).
      const snap = await db.collection('cycles').where('workspaceId', '==', principal.workspaceId).get();
      let cycles = snap.docs.map((d) => d.data());
      if (teamId) cycles = cycles.filter((c) => c.teamId === teamId);
      if (status) cycles = cycles.filter((c) => c.status === status);
      cycles.sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());
      return textResult(cycles);
    }
  );
}
