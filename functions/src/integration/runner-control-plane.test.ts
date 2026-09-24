import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AssignExecutionAgentAction } from '../actions/issues/assign-execution-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { ListRunnerJobsAction, RevokeRunnerAction } from '../actions/runners/manage-runners';
import { jobCanAccessArgs, jobToolRequiresExplicitRepo } from '../mcp/server';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Este test debe ejecutarse mediante Firebase Emulator.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const workspaceId = `ws-${suffix}`;
const ownerId = `owner-${suffix}`;
const otherId = `other-${suffix}`;
const adminId = `admin-${suffix}`;
const agentId = `agent-${suffix}`;
const runnerId = `runner-${suffix}`;
const issueId = `issue-${suffix}`;

async function seed() {
  await db.collection('members').doc(`${workspaceId}_${ownerId}`).set({ workspaceId, userId: ownerId, role: 'member' });
  await db.collection('members').doc(`${workspaceId}_${otherId}`).set({ workspaceId, userId: otherId, role: 'member' });
  await db.collection('members').doc(`${workspaceId}_${adminId}`).set({ workspaceId, userId: adminId, role: 'admin' });
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
  assert.equal(await jobCanAccessArgs(principal, { identifier: issueId }, true), false);
  assert.equal(jobToolRequiresExplicitRepo('pulse_create_branch'), true);
  assert.equal(await jobCanAccessArgs(principal, { identifier: issueId }, jobToolRequiresExplicitRepo('pulse_create_branch')), false);
});

test('emulator: no se vincula un agente a un Runner que no cubre sus repos existentes', async () => {
  await seed();
  await db.collection('agents').doc(agentId).update({ allowedRepos: ['owner/repo'] });
  await db.collection('runners').doc(runnerId).update({ connectedRepos: ['owner/other'] });
  const result = await new UpdateAgentAction({ actionCode: 'agents.update', data: { agentId, runnerId } }, ownerId).run();
  assert.equal(result.success, false);
});

test('emulator: un admin tampoco puede vincular un agente público a un Runner sin sus repos', async () => {
  await seed();
  await db.collection('agents').doc(agentId).update({ visibility: 'public', allowedRepos: ['owner/repo'] });
  await db.collection('runners').doc(runnerId).update({ connectedRepos: ['owner/other'] });
  const result = await new UpdateAgentAction({ actionCode: 'agents.update', data: { agentId, runnerId } }, adminId).run();
  assert.equal(result.success, false);
});

test('emulator: el historial de jobs no filtra actividad de Runners ajenos', async () => {
  await seed();
  const otherRunnerId = `runner-other-${suffix}`;
  await db.collection('runners').doc(otherRunnerId).set({ id: otherRunnerId, workspaceId, ownerMemberId: otherId, status: 'online' });
  await db.collection('runner_jobs').doc(`job-own-${suffix}`).set({ id: `job-own-${suffix}`, workspaceId, runnerId, issueId, agentId, repoFullName: 'owner/repo', mode: 'task', status: 'failed', issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z' });
  await db.collection('runner_jobs').doc(`job-other-${suffix}`).set({ id: `job-other-${suffix}`, workspaceId, runnerId: otherRunnerId, issueId, agentId, repoFullName: 'other/repo', mode: 'task', status: 'failed', issuedAt: '2026-01-02T00:00:00.000Z', expiresAt: '2026-01-02T00:05:00.000Z' });
  const result = await new ListRunnerJobsAction({ actionCode: 'runners.listJobs', data: { workspaceId } }, ownerId).run();
  assert.equal(result.success, true);
  assert.deepEqual((result.data as any).jobs.map((job: any) => job.id), [`job-own-${suffix}`]);
});
