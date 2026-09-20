import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpPrincipal } from '../auth';
import { ALL_TOOL_NAMES, TOOL_SCOPES } from '../scopes';
import { registerIssueReadTools } from './read-issues';
import { registerWorkspaceReadTools } from './read-workspace';
import { registerRunReadTools } from './read-runs';

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
 * Resuelve un `Member` del workspace por su `userId` (que para un agente es su
 * propio `agentId`: `create-agent.ts`/`migrate-agent-roles.mjs` siembran el
 * mismo id como `member.userId` de su espejo). Usado para resolver a nombre
 * cualquier id de persona/agente que devuelve `pulse_get_issue`
 * (`assigneeId`, `creatorId`, `updatedBy`) o `pulse_list_comments`
 * (`authorId`) — D22/TES-218.
 */
export async function findMembersByUserIds(workspaceId: string, userIds: string[]) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map<string, FirebaseFirestore.DocumentData>();
  const db = getFirestore();
  const snaps = await db.getAll(...uniqueIds.map((id) => db.collection('members').doc(`${workspaceId}_${id}`)));
  const byUserId = new Map<string, FirebaseFirestore.DocumentData>();
  snaps.forEach((snap) => {
    if (snap.exists) byUserId.set(snap.data()!.userId, snap.data()!);
  });
  return byUserId;
}

/**
 * Registers the read-only tools. All of them resolve `workspaceId` from
 * `principal` (set by `authenticateRequest`) rather than accepting it as a
 * tool input — an agent cannot read another workspace's data by asking for
 * its id, because the tool never looks at anything the model could supply.
 *
 * Split por dominio (D22/TES-218) porque el archivo único superaba las ~400
 * líneas que dispara el TS2589 de `zod ^4` documentado en `write.ts`/README:
 * `read-issues.ts` (issue, épica, comentarios, actividad, contexto de
 * revisión), `read-workspace.ts` (equipos, proyectos, etiquetas, miembros,
 * agentes, ciclos) y `read-runs.ts` (`agent_runs`). Este archivo conserva los
 * helpers compartidos (usados también por `write.ts`) y `pulse_whoami`, que
 * tiene que funcionar aun para una key sin scopes.
 */
export function registerReadTools(server: McpServer, principal: McpPrincipal) {
  server.registerTool(
    'pulse_whoami',
    {
      title: 'Pulse whoami',
      description:
        "Returns the caller's resolved identity: workspace, agent id (if any), granted scopes, and the tool names those scopes actually enable — check this before calling a tool you're not sure you have access to.",
      inputSchema: {},
    },
    async () => {
      const tools = ALL_TOOL_NAMES.filter((name) => {
        const required = TOOL_SCOPES[name];
        return !required || principal.scopes.includes(required);
      });
      return textResult({ workspaceId: principal.workspaceId, agentId: principal.agentId, scopes: principal.scopes, tools });
    }
  );

  registerIssueReadTools(server, principal);
  registerWorkspaceReadTools(server, principal);
  registerRunReadTools(server, principal);
}
