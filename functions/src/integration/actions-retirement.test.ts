import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { agentDispatchTrigger } from '../triggers/agent-dispatch';
import { DisconnectRepoAction } from '../actions/agents/disconnect-repo';
import { ConnectRepoAction } from '../actions/agents/connect-repo';
import { authenticateRequest } from '../mcp/auth';
import { generateApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { todayKey } from '../common/utils/dispatch-counter';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
process.env.MCP_KEY_PEPPER = 'retirement-test-only';

for (const mode of ['task', 'rework', 'handoff']) {
  test(`retired Actions ${mode} records a diagnostic with no reservations or budget`, async () => {
    const id = `retirement-${mode}-${Date.now()}`;
    await db.collection('agents').doc(id).set({ workspaceId: id, enabled: true, autonomousMode: true, kind: 'claude' });
    const before = { status: 'backlog' };
    const after: Record<string, any> = { workspaceId: id, execution: { agentId: id }, status: mode === 'task' ? 'todo' : 'in_progress' };
    if (mode === 'rework') after.review = { state: 'changes_requested', attempt: 1 };
    if (mode === 'handoff') after.pendingRepoWork = [{ repoFullName: 'owner/repo', requestedAt: new Date().toISOString() }];
    const ref = db.collection('issues').doc(id); await ref.set(after);
    const event = { params: { issueId: id }, data: { before: { data: () => before }, after: { data: () => after } } };
    await agentDispatchTrigger.run(event as any);
    const issue = (await ref.get()).data()!;
    assert.equal(issue.agent.state, 'blocked'); assert.match(issue.agent.blockedReason, /Runner local/);
    assert.equal(issue.agent.dispatchedAt, undefined);
    assert.equal(issue.review?.reworkDispatchedForAttempt, undefined);
    assert.equal(issue.pendingRepoWork?.[0].dispatchedAt, undefined);
    assert.equal((await db.collection('runner_jobs').where('issueId', '==', id).get()).size, 0);
    assert.equal((await db.collection('agent_runs').where('issueId', '==', id).get()).size, 0);
    assert.equal((await db.collection('agent_dispatch_counters').doc(`${id}_${todayKey()}`).get()).exists, false);
    // The diagnostic itself must not cause a handoff write loop.
    await agentDispatchTrigger.run({ ...event, data: { before: { data: () => issue }, after: { data: () => structuredClone(issue) } } } as any);
    assert.deepEqual((await ref.get()).data(), issue);
  });
}

test('old connect clients cannot create credentials, secrets or workflows for either provider', async () => {
  const id = `retirement-connect-${Date.now()}`;
  await db.collection('members').doc(`${id}_owner`).set({ workspaceId: id, userId: 'owner', role: 'owner' });
  for (const kind of ['claude', 'codex']) {
    await db.collection('agents').doc(`${id}-${kind}`).set({ workspaceId: id, kind, enabled: true });
    const result = await new ConnectRepoAction({ actionCode: 'agents.connectRepo', data: { workspaceId: id, agentId: `${id}-${kind}`, repoFullName: 'owner/repo' } }, 'owner').run();
    assert.equal(result.success, false); assert.match(result.error!, /Runner local/);
  }
  assert.equal((await db.collection('api_keys').where('workspaceId', '==', id).get()).size, 0);
});

test('only dedicated agent Actions keys are rejected; manual, Salesforce and Runner credentials survive', async () => {
  const id = `retirement-auth-${Date.now()}`;
  await db.collection('agents').doc(id).set({ workspaceId: id });
  for (const [label, fields] of Object.entries({ legacy: { agentId: id, connectedRepo: 'owner/repo' }, manual: { agentId: id }, salesforce: { agentId: null, connectedRepo: 'owner/repo' }, runner: { agentId: id, jobId: 'job-test', runnerId: 'runner-test' } })) {
    const key = generateApiKey();
    await db.collection('api_keys').doc(key.keyId).set({ workspaceId: id, createdBy: 'owner', scopes: [], hash: hashApiKeySecret(key.secret, process.env.MCP_KEY_PEPPER!), lastUsedAt: new Date().toISOString(), ...fields });
    if (label === 'legacy') await assert.rejects(authenticateRequest(`Bearer ${key.fullKey}`), /retired/);
    else assert.equal((await authenticateRequest(`Bearer ${key.fullKey}`)).workspaceId, id);
  }
});

for (const mismatched of [false, true]) {
  test(`retiring a connection ${mismatched ? 'protects unrelated keys' : 'preserves Runner policy and history'}`, async () => {
    const id = `retirement-cleanup-${mismatched}-${Date.now()}`;
    const keyId = `${id}-key`;
    const ref = db.collection('agents').doc(id);
    await db.collection('members').doc(`${id}_owner`).set({ workspaceId: id, userId: 'owner', role: 'owner' });
    await ref.set({ workspaceId: id, role: 'dev', allowedRepos: ['owner/repo'], runnerId: 'runner-test', connectedRepos: [{ repoFullName: 'owner/repo', apiKeyId: keyId }] });
    await db.collection('agent_runs').doc(id).set({ workspaceId: id, agentId: id });
    const key = db.collection('api_keys').doc(keyId);
    await key.set({ workspaceId: id, agentId: mismatched ? 'unrelated' : id, connectedRepo: 'owner/repo' });
    const result = await new DisconnectRepoAction({ actionCode: 'agents.disconnectRepo', data: { workspaceId: id, agentId: id, repoFullName: 'owner/repo' } }, 'owner').run();
    assert.equal(result.success, !mismatched);
    assert.equal(!!(await key.get()).data()?.revokedAt, !mismatched);
    assert.deepEqual((await ref.get()).data()?.allowedRepos, ['owner/repo']);
    assert.equal((await ref.get()).data()?.runnerId, 'runner-test');
    assert.equal((await ref.get()).data()?.connectedRepos.length, mismatched ? 1 : 0);
    assert.equal((await db.collection('agent_runs').doc(id).get()).exists, true);
  });
}
