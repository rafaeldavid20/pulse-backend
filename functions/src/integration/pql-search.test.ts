import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { buildMcpTransport } from '../mcp/server';
import { authenticateRequest, type McpPrincipal } from '../mcp/auth';
import { generateApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { generateOauthToken } from '../common/utils/oauth-token';
import { mcpKeyPepper } from '../common/secrets';
import { execute } from '../common/pql';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'demo-pulse-pql' });
const db = getFirestore();
mcpKeyPepper.value = () => 'integration-only-pepper';
const uid = () => randomBytes(6).toString('hex');
async function call(principal: McpPrincipal, method: string, params?: object) {
  const transport = await buildMcpTransport(principal);
  try {
    const response = await transport.handleRequest(new Request('http://localhost/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return (await response.json() as any).result;
  } finally { await transport.close(); }
}
async function search(principal: McpPrincipal, args: object) {
  const response = await call(principal, 'tools/call', { name: 'pulse_search', arguments: args });
  let data: any;
  try { data = JSON.parse(response.content[0].text); } catch { data = { message: response.content[0].text }; }
  return { ...response, data };
}

test('MCP search discovery, identity, scope, ordering and errors', async () => {
  const suffix = uid(), ws = `ws-${suffix}`, team = `team-${suffix}`, otherTeam = `other-${suffix}`, human = `user-${suffix}`, agent = `agent-${suffix}`;
  const key = generateApiKey(), personalKey = generateApiKey(), oauth = generateOauthToken();
  await Promise.all([
    db.collection('teams').doc(team).set({ workspaceId: ws, key: 'TES', name: 'Team' }),
    db.collection('teams').doc(otherTeam).set({ workspaceId: ws, key: 'OTH', name: 'Other' }),
    db.collection('members').doc(`${ws}_${human}`).set({ workspaceId: ws, userId: human, displayName: 'Human' }),
    db.collection('members').doc(`${ws}_${agent}`).set({ workspaceId: ws, userId: agent, displayName: 'Agent' }),
    db.collection('agents').doc(agent).set({ workspaceId: ws, role: 'dev' }),
    db.collection('api_keys').doc(key.keyId).set({ workspaceId: ws, createdBy: human, agentId: agent, scopes: ['issues:read'], hash: hashApiKeySecret(key.secret, 'integration-only-pepper') }),
    db.collection('api_keys').doc(personalKey.keyId).set({ workspaceId: ws, createdBy: human, scopes: ['issues:read'], hash: hashApiKeySecret(personalKey.secret, 'integration-only-pepper') }),
    db.collection('oauth_tokens').doc(oauth.tokenId).set({ workspaceId: ws, userId: human, scopes: ['issues:read'], hash: hashApiKeySecret(oauth.secret, 'integration-only-pepper') }),
    db.collection('cycles').doc(`cycle-${suffix}`).set({ workspaceId: ws, teamId: team, status: 'active', endsAt: '2025-01-31T00:00:00Z' }),
  ]);
  const batch = db.batch();
  for (let n = 0; n < 205; n++) {
    const id = `issue-${suffix}-${String(n).padStart(3, '0')}`;
    batch.set(db.collection('issues').doc(id), { workspaceId: ws, teamId: team, identifier: `TES-${n + 1}`, title: `Issue ${n}`, status: n === 204 ? 'in_review' : 'todo', assigneeId: n === 204 ? agent : human, priority: 2, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z', description: 'private detail' });
  }
  batch.set(db.collection('issues').doc(`foreign-${suffix}`), { workspaceId: `foreign-${ws}`, teamId: team, identifier: 'NO-1', title: 'Foreign', status: 'in_review' });
  batch.set(db.collection('issues').doc(`other-${suffix}`), { workspaceId: ws, teamId: otherTeam, identifier: 'OTH-1', title: 'Other', type: 'epic', status: 'in_review', assigneeId: agent });
  await batch.commit();
  const agentPrincipal = await authenticateRequest(`Bearer ${key.fullKey}`);
  const humanPrincipal = await authenticateRequest(`Bearer ${oauth.fullToken}`);
  const personalPrincipal = await authenticateRequest(`Bearer ${personalKey.fullKey}`);
  const list = await call(agentPrincipal, 'tools/list');
  assert.ok(list.tools.some((tool: any) => tool.name === 'pulse_search'));
  const result = await search(agentPrincipal, { query: 'status = in_review AND assignee = me()', teamKey: 'TES' });
  assert.equal(result.data.total, 1); assert.equal(result.data.issues[0].identifier, 'TES-205');
  assert.equal(result.data.issues[0].description, undefined);
  assert.equal((await search(agentPrincipal, { query: 'epic = OTH-1', teamKey: 'TES' })).data.total, 0);
  const personal = await search(humanPrincipal, { query: 'assignee = me()', limit: 25 });
  assert.equal(personal.data.total, 204); assert.equal(personal.data.returned, 25); assert.equal(personal.data.hasMore, true);
  assert.equal((await search(personalPrincipal, { query: 'assignee = me()', limit: 100 })).data.total, 204);
  const parityQuery = 'assignee = me() OR (status = in_review AND updated < now()) ORDER BY priority ASC, updated DESC';
  const remote = await search(humanPrincipal, { query: parityQuery, teamKey: 'TES', limit: 100 });
  const snapshot = await db.collection('issues').where('workspaceId', '==', ws).where('teamId', '==', team).get();
  const local = execute(parityQuery, snapshot.docs.map(d => ({ ...d.data(), id: d.id })), { workspaceId: ws, actorId: human, teamId: team, now: remote.data.evaluatedAt, teams: [], members: [], projects: [], labels: [], cycles: [], issues: [] });
  assert.equal(local.ok, true);
  if (local.ok) assert.deepEqual(remote.data.issues.map((i: any) => i.id), local.issues.slice(0, 100).map(i => i.id));
  assert.equal((await search(humanPrincipal, { query: 'status =', teamKey: 'TES' })).isError, true);
  assert.equal((await search(humanPrincipal, { query: '', limit: 101 })).data.code, 'INVALID_ARGUMENT');
  assert.equal((await search(humanPrincipal, { query: '', teamKey: 'NOPE' })).data.code, 'SCOPE_UNAVAILABLE');
  assert.equal((await search(humanPrincipal, { query: '', workspaceId: `foreign-${ws}` })).isError, true);
  assert.equal((await search({ ...humanPrincipal, scopes: [] }, { query: '' })).isError, true);
  assert.equal((await search({ ...agentPrincipal, jobId: 'job', issueId: 'issue-x', runnerId: 'runner' }, { query: '' })).isError, true);
});

test('5000 candidates are complete and 5001 fail without partial results', async () => {
  const suffix = uid(), ws = `ws-large-${suffix}`, team = `team-large-${suffix}`;
  await db.collection('teams').doc(team).set({ workspaceId: ws, key: 'TES', name: 'Team' });
  for (let start = 0; start < 5001; start += 400) {
    const batch = db.batch();
    for (let n = start; n < Math.min(start + 400, 5001); n++) {
      const id = `large-${suffix}-${String(n).padStart(4, '0')}`;
      batch.set(db.collection('issues').doc(id), { workspaceId: ws, teamId: n === 5000 ? 'another-team' : team, identifier: `TES-${n + 1}`, title: `Issue ${n}`, status: 'todo', priority: 2, createdAt: '2024-01-01T00:00:00Z' });
    }
    await batch.commit();
  }
  const principal: McpPrincipal = { workspaceId: ws, agentId: null, createdBy: 'owner', scopes: ['issues:read'], source: 'api_key' };
  const bounded = await search(principal, { query: '', teamKey: 'TES', limit: 100 });
  assert.equal(bounded.data.total, 5000); assert.equal(bounded.data.returned, 100); assert.equal(bounded.data.hasMore, true);
  const excessive = await search(principal, { query: '' });
  assert.equal(excessive.isError, true); assert.equal(excessive.data.code, 'QUERY_SCOPE_TOO_LARGE'); assert.equal(excessive.data.issues, undefined);
});
