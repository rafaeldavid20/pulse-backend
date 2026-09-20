import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult, findIssue } from './read';

const DEFAULT_RUNS_LIMIT = 25;
const MAX_RUNS_LIMIT = 100;
// Tope duro sobre cuántos `agent_runs` del workspace se traen antes de
// ordenar/paginar en memoria (mismo patrón que `pulse_list_issues`), para no
// necesitar un índice compuesto por `workspaceId` + `startedAt` (ver riesgo
// del issue: D22/TES-218).
const WORKSPACE_RUNS_FETCH_CAP = 500;

export function registerRunReadTools(server: McpServer, principal: McpPrincipal) {
  const db = getFirestore();

  server.tool(
    'pulse_list_runs',
    'Lists agent_runs (AgentRun) — dev and QA runs, with mode, outcome, cost and duration — without opening GitHub Actions. Pass identifier to scope to one issue’s runs, or omit it for the workspace’s most recent runs.',
    {
      identifier: z.string().optional().describe('Issue identifier ("ENG-142") or doc id — scopes to that issue’s runs. Omit for the whole workspace.'),
      limit: z.number().int().min(1).max(MAX_RUNS_LIMIT).default(DEFAULT_RUNS_LIMIT),
    },
    async ({ identifier, limit }) => {
      let query = db.collection('agent_runs').where('workspaceId', '==', principal.workspaceId) as FirebaseFirestore.Query;

      if (identifier) {
        const doc = await findIssue(principal.workspaceId, identifier);
        if (!doc) return textResult({ runs: [], note: `No issue found for '${identifier}'.` });
        query = query.where('issueId', '==', doc.id);
      }

      const snap = await query.limit(WORKSPACE_RUNS_FETCH_CAP).get();
      const runs = snap.docs.map((d) => d.data());
      runs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      return textResult({
        runs: runs.slice(0, limit).map((r) => ({
          id: r.id,
          issueId: r.issueId,
          agentId: r.agentId,
          role: r.role,
          mode: r.mode,
          repo: r.repo,
          runUrl: r.runUrl,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          turns: r.turns,
          costUsd: r.costUsd,
          outcome: r.outcome,
          reviewAttempt: r.reviewAttempt,
        })),
        ...(runs.length > limit ? { note: `Hay más runs de los que trae este límite (${limit}) — subí "limit" para ver más.` } : {}),
      });
    }
  );
}
