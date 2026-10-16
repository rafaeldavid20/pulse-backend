import { getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Static import — ver el comentario de cabecera de `read.ts` sobre TS2589.
import { z } from 'zod';
import { McpPrincipal } from '../auth';
import { textResult, findIssue } from './read';
import { buildRunConfig, isRunMode } from '../../run-config';

const DEFAULT_RUNS_LIMIT = 25;
const MAX_RUNS_LIMIT = 100;
// Tope duro sobre cuántos `agent_runs` del workspace se traen antes de
// ordenar/paginar en memoria (mismo patrón que `pulse_list_issues`), para no
// necesitar un índice compuesto por `workspaceId` + `startedAt` (ver riesgo
// del issue: D22/TES-218).
const WORKSPACE_RUNS_FETCH_CAP = 500;

export function registerRunReadTools(server: McpServer, principal: McpPrincipal) {
  const db = getFirestore();

  async function resolveManagedSkills(issue: FirebaseFirestore.DocumentData): Promise<ReturnType<typeof buildRunConfig>['skills']> {
    const agentId = principal.agentId;
    if (!agentId) return [];
    const agentSnap = await db.collection('agents').doc(agentId).get();
    const agent = agentSnap.data();
    if (!agent || agent.workspaceId !== principal.workspaceId || agent.archivedAt) return [];
    const projectSnap = issue.projectId ? await db.collection('projects').doc(issue.projectId).get() : null;
    const project = projectSnap?.data();
    if (project && project.workspaceId !== principal.workspaceId) return [];
    const workspaceSnap = await db.collection('workspaces').doc(principal.workspaceId).get();
    const tiers = [
      { source: 'agent' as const, ids: agent.managedSkillIds || [] },
      { source: 'project' as const, ids: project?.managedSkillIds || [] },
      { source: 'workspace' as const, ids: workspaceSnap.data()?.managedSkillIds || [] },
    ];
    const resolved: ReturnType<typeof buildRunConfig>['skills'] = [];
    const usedNames = new Set<string>();
    for (const tier of tiers) {
      const ids = [...new Set<string>(tier.ids.filter((id: unknown): id is string => typeof id === 'string'))];
      const docs = await Promise.all(ids.map(id => db.collection('managed_skills').doc(id).get()));
      const candidates = docs.map(snap => ({ id: snap.id, ...snap.data() })).filter((skill: any) =>
        skill && skill.workspaceId === principal.workspaceId && skill.status === 'active' &&
        typeof skill.name === 'string' && typeof skill.content === 'string' && Number.isSafeInteger(skill.version)
      ) as Array<{ id: string; name: string; content: string; version: number; workspaceId: string }>;
      const byName = new Map<string, typeof candidates>();
      for (const skill of candidates) byName.set(skill.name, [...(byName.get(skill.name) || []), skill]);
      for (const [name, matches] of byName) {
        if (usedNames.has(name)) continue;
        if (matches.length > 1) throw new Error(`Conflicto de skills gestionados para '${name}' en nivel ${tier.source}; elegí una sola versión.`);
        const skill = matches[0];
        resolved.push({ id: skill.id, name, content: skill.content, version: skill.version, source: tier.source });
        usedNames.add(name);
      }
    }
    return resolved;
  }

  server.tool(
    'pulse_get_run_config',
    'Returns the configuration this run has to start with: the prompt for its mode, the tools it may and may not use, and the skills to materialize before invoking Claude. The Pulse workflow calls this at the beginning of every run — it is not something the model needs to call mid-session. It exists so that changing a prompt, a tool policy or a skill does not require rewriting the workflow in every repo and reconnecting them.',
    {
      identifier: z.string().describe('Issue identifier ("ENG-142") or doc id.'),
      mode: z.enum(['task', 'rework', 'review']).describe('Which run this is: a new task, a dev rework after changes_requested, or a QA review.'),
      handoffRepo: z.string().optional().describe('Only for "task": target repo when this run continues a cross-repo handoff.'),
      reviewAttempt: z.number().int().optional().describe('Only for "rework"/"review": the review attempt number.'),
    },
    async ({ identifier, mode, handoffRepo, reviewAttempt }) => {
      const doc = await findIssue(principal.workspaceId, identifier);
      if (!doc) return textResult({ error: `No issue found for '${identifier}'.` });
      if (!isRunMode(mode)) return textResult({ error: `Invalid run mode '${String(mode)}'.` });

      const issue = doc.data()!;
      return textResult(
        buildRunConfig(mode, {
          issueId: doc.id,
          issueIdentifier: issue.identifier,
          handoffRepo,
          reviewAttempt,
          skills: await resolveManagedSkills(issue),
        })
      );
    }
  );

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
