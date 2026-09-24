import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AssignExecutionAgentAction } from '../actions/issues/assign-execution-agent';
import { RevokeRunnerAction } from '../actions/runners/manage-runners';
import { jobCanAccessArgs } from '../mcp/server';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Este test debe ejecutarse mediante Firebase Emulator.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const workspaceId = `ws-${suffix}`;
const ownerId = `owner-${suffix}`;
const otherId = `other-${suffix}`;
const agentId = `agent-${suffix}`;
const runnerId = `runner-${suffix}`;
const issueId = `issue-${suffix}`;

async function seed() {
  await db.collection('members').doc(`${workspaceId}_${ownerId}`).set({ workspaceId, userId: ownerId, role: 'member' });
  await db.collection('members').doc(`${workspaceId}_${otherId}`).set({ workspaceId, userId: otherId, role: 'member' });
  await db.collection('agents').doc(agentId).set({ id: agentId, workspaceId, ownerMemberId: ownerId, visibility: 'personal', enabled: true });
  await db.collection('issues').doc(issueId).set({ id: issueId, workspaceId, identifier: `INT-${suffix}`, assigneeId: ownerId, responsibleMemberId: ownerId });
  await db.collection('runners').doc(runnerId).set({ id: runnerId, workspaceId, ownerMemberId: ownerId, status: 'online', deviceSecretHash: 'hash' });
}

test('emulator: un usuario no puede asignar el agente personal de otra persona', async () => {
  await seed();
  const denied = await new AssignExecutionAgentAction({ actionCode: 'issues.assignExecutionAgent', data: { issueId, agentId } }, otherId).run();
  assert.equal(denied.success, false);
  const accepted = await new AssignExecutionAgentAction({ actionCode: 'issues.assignExecutionAgent', data: { issueId, agentId } }, ownerId).run();
  assert.equal(accepted.success, true);
  assert.equal((await db.collection('issues').doc(issueId).get()).data()?.execution.agentId, agentId);
});

test('emulator: revocar un Runner conserva auditoría y corta la credencial', async () => {
  await seed();
  const result = await new RevokeRunnerAction({ actionCode: 'runners.revoke', data: { runnerId } }, ownerId).run();
  assert.equal(result.success, true);
  const runner = (await db.collection('runners').doc(runnerId).get()).data();
  assert.equal(runner?.status, 'offline');
  assert.ok(runner?.revokedAt);
  assert.equal(runner?.deviceSecretHash, null);
});

test('emulator: la credencial de job sólo puede señalar su issue y repo', async () => {
  await seed();
  const principal: any = { workspaceId, createdBy: ownerId, agentId, scopes: ['issues:read'], source: 'api_key', jobId: 'job', issueId, runnerId, repoFullName: 'owner/repo' };
  assert.equal(await jobCanAccessArgs(principal, { identifier: issueId, repoFullName: 'owner/repo' }), true);
  assert.equal(await jobCanAccessArgs(principal, { identifier: issueId, repoFullName: 'owner/other' }), false);
  assert.equal(await jobCanAccessArgs(principal, {}), false);
});
