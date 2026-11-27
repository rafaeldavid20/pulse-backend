import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpPrincipal } from '../auth';
import { parse, resolve, evaluate, type Context, type Entity, type Expression } from '../../common/pql';
import { textResult } from './read';

const MAX_CANDIDATES = 5000;
const PAGE_SIZE = 500;
function errorResult(code: string, message: string, details?: object) {
  return { ...textResult({ code, message, ...details }), isError: true };
}
async function readIssues(query: FirebaseFirestore.Query): Promise<FirebaseFirestore.QueryDocumentSnapshot[]> {
  const docs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  while (docs.length <= MAX_CANDIDATES) {
    let page = query.orderBy(FieldPath.documentId()).limit(Math.min(PAGE_SIZE, MAX_CANDIDATES + 1 - docs.length));
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    docs.push(...snap.docs);
    if (snap.size < PAGE_SIZE || docs.length > MAX_CANDIDATES) break;
    cursor = snap.docs[snap.docs.length - 1];
  }
  return docs;
}
function safeIssue(issue: FirebaseFirestore.DocumentData) {
  const { id, identifier, title, status, priority, type, assigneeId, creatorId, projectId, parentId, epicId, teamId, cycleId, labelIds, createdAt, updatedAt, dueDate, estimate } = issue;
  return { id, identifier, title, status, priority, type, assigneeId, creatorId, projectId, parentId, epicId, teamId, cycleId, labelIds, createdAt, updatedAt, dueDate, estimate,
    agent: issue.agent?.state ? { state: issue.agent.state } : undefined,
    git: issue.git?.prState ? { prState: issue.git.prState } : undefined,
    review: issue.review ? { state: issue.review.state, reviewerId: issue.review.reviewerId, verdict: issue.review.verdict } : undefined };
}
function issueReferences(expression?: Expression): string[] {
  if (!expression) return [];
  if (expression.kind === 'and' || expression.kind === 'or') return [...issueReferences(expression.left), ...issueReferences(expression.right)];
  if (expression.kind === 'not') return issueReferences(expression.expression);
  return ['epic', 'parent'].includes(expression.field.toLowerCase()) ? expression.values.filter(v => v.kind === 'literal').map(v => v.value) : [];
}

export function registerSearchTool(server: McpServer, principal: McpPrincipal) {
  const invalidString = '\u0000PQL_INVALID_ARGUMENT\u0000';
  server.registerTool('pulse_search', {
    description: 'Search authorized workspace issues with PQL v1. Results are ordered before the output limit; at most 5000 candidates are supported.',
    inputSchema: z.object({ query: z.string().catch(invalidString), limit: z.number().catch(NaN).optional(), teamKey: z.string().catch(invalidString).optional() }).passthrough(),
  },
    async (input) => {
      if (input.query === invalidString || input.teamKey === invalidString || Object.keys(input).some(key => !['query', 'limit', 'teamKey'].includes(key))) return errorResult('INVALID_ARGUMENT', 'Se requiere query como texto y sólo se admiten query, limit y teamKey.');
      const { query, limit = 25, teamKey } = input;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return errorResult('INVALID_ARGUMENT', 'limit debe ser un entero entre 1 y 100.');
      if (teamKey !== undefined && !/^[a-z][a-z0-9_-]{0,31}$/i.test(teamKey)) return errorResult('INVALID_ARGUMENT', 'teamKey no es válido.');
      const parsed = parse(query);
      if (!parsed.ok) return errorResult(parsed.diagnostic.code, parsed.diagnostic.message, parsed.diagnostic);
      const db = getFirestore();
      try {
        const teamSnap = await db.collection('teams').where('workspaceId', '==', principal.workspaceId).get();
        const teams = teamSnap.docs.map(d => ({ ...d.data(), id: d.id })) as Entity[];
        const team = teamKey ? teams.find(t => t.key?.toLowerCase() === teamKey.toLowerCase()) : undefined;
        if (teamKey && !team) return errorResult('SCOPE_UNAVAILABLE', 'El equipo no está disponible en el ámbito autorizado.');
        const base = db.collection('issues').where('workspaceId', '==', principal.workspaceId);
        const scoped = team ? base.where('teamId', '==', team.id) : base;
        const [candidateDocs, memberSnap, projectSnap, labelSnap, cycleSnap, agentSnap] = await Promise.all([
          readIssues(scoped),
          db.collection('members').where('workspaceId', '==', principal.workspaceId).get(),
          db.collection('projects').where('workspaceId', '==', principal.workspaceId).get(),
          db.collection('labels').where('workspaceId', '==', principal.workspaceId).get(),
          db.collection('cycles').where('workspaceId', '==', principal.workspaceId).get(),
          db.collection('agents').where('workspaceId', '==', principal.workspaceId).get(),
        ]);
        if (candidateDocs.length > MAX_CANDIDATES) return errorResult('QUERY_SCOPE_TOO_LARGE', 'El ámbito supera 5000 issues; acotá teamKey.');
        let allIssueDocs = candidateDocs;
        const references = [...new Set(issueReferences(parsed.query.expression))];
        if (team && references.length) {
          const idRefs = references.filter(v => /^[A-Za-z0-9_-]{1,1500}$/.test(v)).map(v => db.collection('issues').doc(v));
          const identifiers = references.filter(v => /^[a-z][a-z0-9_]*-\d+$/i.test(v)).map(v => v.toUpperCase());
          const direct: FirebaseFirestore.DocumentSnapshot[] = [];
          for (let i = 0; i < idRefs.length; i += 200) direct.push(...await db.getAll(...idRefs.slice(i, i + 200)));
          const named: FirebaseFirestore.QueryDocumentSnapshot[] = [];
          for (let i = 0; i < identifiers.length; i += 30) {
            const snap = await base.where('identifier', 'in', identifiers.slice(i, i + 30)).get();
            named.push(...snap.docs);
          }
          const foundIds = new Set(direct.filter(d => d.exists && d.data()?.workspaceId === principal.workspaceId).map(d => d.id));
          const names = references.filter(v => !foundIds.has(v) && !/^issue-[\w-]+$/i.test(v) && !/^[a-z][a-z0-9_]*-\d+$/i.test(v));
          if (names.length) {
            allIssueDocs = await readIssues(base.select('identifier', 'title', 'type', 'teamId'));
            if (allIssueDocs.length > MAX_CANDIDATES) return errorResult('QUERY_SCOPE_TOO_LARGE', 'El catálogo de nombres supera 5000 issues; usá IDs o identificadores.');
          } else {
            const unique = new Map(candidateDocs.map(d => [d.id, d]));
            for (const d of [...direct, ...named]) if (d.exists && d.data()?.workspaceId === principal.workspaceId) unique.set(d.id, d as FirebaseFirestore.QueryDocumentSnapshot);
            allIssueDocs = [...unique.values()];
          }
        }
        const entities = (snap: FirebaseFirestore.QuerySnapshot): Entity[] => snap.docs.map(d => ({ ...d.data(), id: d.id })) as Entity[];
        const now = new Date().toISOString();
        const context: Context = {
          workspaceId: principal.workspaceId, actorId: principal.agentId ?? principal.createdBy, now, teamId: team?.id,
          teams, members: entities(memberSnap), projects: entities(projectSnap), labels: entities(labelSnap), cycles: entities(cycleSnap), agents: entities(agentSnap),
          issues: allIssueDocs.map(d => ({ id: d.id, identifier: d.get('identifier'), name: d.get('title'), type: d.get('type'), teamId: d.get('teamId') })),
        };
        const resolved = resolve(query, parsed.query, context);
        if (!resolved.ok) return errorResult(resolved.diagnostic.code, resolved.diagnostic.message, resolved.diagnostic);
        const candidates = candidateDocs.map(d => ({ ...d.data(), id: d.id }));
        const matched = evaluate(resolved.query, candidates);
        return textResult({ query, queryVersion: 1, evaluatedAt: now, issues: matched.slice(0, limit).map(safeIssue), total: matched.length, returned: Math.min(limit, matched.length), hasMore: matched.length > limit, scope: team ? { teamKey: team.key } : {} });
      } catch {
        return errorResult('SEARCH_FAILED', 'No se pudo completar la búsqueda. Intentá nuevamente.');
      }
    });
}
