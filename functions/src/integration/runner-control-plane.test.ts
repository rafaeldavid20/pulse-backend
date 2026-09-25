import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AssignExecutionAgentAction } from '../actions/issues/assign-execution-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { DeleteAgentAction } from '../actions/agents/delete-agent';
import { ListRunnerJobsAction, RevokeRunnerAction } from '../actions/runners/manage-runners';
import { GetAgentUsageAction } from '../actions/agents/get-usage';
import { recordRunnerCompletion } from '../runners/record-completion';
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
  await db.collection('members').doc(`${workspaceId}_${agentId}`).set({ workspaceId, userId: agentId, role: 'member', isAgent: true });
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

test('emulator: se elimina un agente personal inactivo y se cortan sus accesos', async () => {
  await seed();
  await db.collection('issues').doc(issueId).update({ execution: { agentId } });
  await db.collection('api_keys').doc(`key-${suffix}`).set({ agentId, workspaceId, revokedAt: null });

  const result = await new DeleteAgentAction({ actionCode: 'agents.delete', data: { agentId } }, ownerId).run();

  assert.equal(result.success, true);
  assert.equal((await db.collection('agents').doc(agentId).get()).exists, false);
  assert.equal((await db.collection('members').doc(`${workspaceId}_${agentId}`).get()).exists, false);
  assert.equal((await db.collection('issues').doc(issueId).get()).data()?.execution, null);
  assert.ok((await db.collection('api_keys').doc(`key-${suffix}`).get()).data()?.revokedAt);
});

test('emulator: no se elimina un agente con actividad ni con ejecuciones activas', async () => {
  await seed();
  await db.collection('agent_runs').doc(`run-${suffix}`).set({ agentId, workspaceId, issueId, startedAt: '2026-01-01T00:00:00.000Z' });
  const history = await new DeleteAgentAction({ actionCode: 'agents.delete', data: { agentId } }, ownerId).run();
  assert.equal(history.success, false);
  assert.match(history.error || '', /actividad registrada/);

  await db.collection('agent_runs').doc(`run-${suffix}`).delete();
  await db.collection('runner_jobs').doc(`job-active-${suffix}`).set({ agentId, workspaceId, status: 'delivered' });
  const active = await new DeleteAgentAction({ actionCode: 'agents.delete', data: { agentId } }, ownerId).run();
  assert.equal(active.success, false);
  assert.match(active.error || '', /ejecuciones activas/);
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

test('emulator: consumo filtra workspace, visibilidad, Runner y período', async () => {
  await seed();
  const otherWorkspace = `ws-other-${suffix}`;
  const otherAgent = `agent-other-${suffix}`;
  await db.collection('agents').doc(agentId).update({ kind: 'claude', displayName: 'Claude', runnerId });
  await db.collection('agents').doc(otherAgent).set({ id: otherAgent, workspaceId, ownerMemberId: otherId, kind: 'codex', displayName: 'Codex', runnerId });
  const base = { workspaceId, issueId, startedAt: '2026-09-20T12:00:00.000Z', mode: 'task', usage: { inputTokens: 5, outputTokens: 2 } };
  await Promise.all([
    db.collection('agent_runs').doc(`local-${suffix}`).set({ ...base, agentId, runnerId }),
    db.collection('agent_runs').doc(`github-${suffix}`).set({ ...base, agentId }),
    db.collection('agent_runs').doc(`other-agent-${suffix}`).set({ ...base, agentId: otherAgent, runnerId }),
    db.collection('agent_runs').doc(`other-workspace-${suffix}`).set({ ...base, workspaceId: otherWorkspace, agentId, runnerId }),
    db.collection('agent_runs').doc(`old-${suffix}`).set({ ...base, agentId, runnerId, startedAt: '2026-01-01T00:00:00.000Z' }),
  ]);
  const period = { from: '2026-09-19T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' };
  const owner = await new GetAgentUsageAction({ actionCode: 'agents.getUsage', data: { workspaceId, ...period } }, ownerId).run();
  assert.equal(owner.success, true);
  assert.deepEqual((owner.data as any).agents.map((agent: any) => agent.id), [agentId]);
  assert.deepEqual((owner.data as any).runs.map((run: any) => run.id), [`local-${suffix}`]);
  const other = await new GetAgentUsageAction({ actionCode: 'agents.getUsage', data: { workspaceId, ...period } }, otherId).run();
  assert.equal(other.success, true);
  assert.deepEqual((other.data as any).runs.map((run: any) => run.id), [`other-agent-${suffix}`]);
  const outsider = await new GetAgentUsageAction({ actionCode: 'agents.getUsage', data: { workspaceId: otherWorkspace, ...period } }, ownerId).run();
  assert.equal(outsider.success, false);
});

test('emulator: el reporte Runner es idempotente y conserva uso parcial de un fallo', async () => {
  await seed();
  const jobId = `job-usage-${suffix}`;
  await db.collection('runner_jobs').doc(jobId).set({ id: jobId, workspaceId, issueId, agentId, runnerId, status: 'delivered', expiresAt: '2099-01-01T00:00:00.000Z' });
  await db.collection('agent_runs').doc(jobId).set({ id: jobId, workspaceId, issueId, agentId, runnerId, startedAt: '2026-09-20T12:00:00.000Z' });
  const report = { usage: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 5 }, costUsd: 0.01 };
  const first = await recordRunnerCompletion(db, jobId, runnerId, 'codex', 'failed', report, '2026-09-20T12:05:00.000Z');
  const retry = await recordRunnerCompletion(db, jobId, runnerId, 'codex', 'failed', { usage: null }, '2026-09-20T12:06:00.000Z');
  assert.equal(first, 'written');
  assert.equal(retry, 'failed');
  const run = (await db.collection('agent_runs').doc(jobId).get()).data()!;
  assert.deepEqual(run.usage, report.usage);
  assert.equal(run.costUsd, 0.01);
  assert.equal(run.runnerOutcome, 'failed');
  assert.equal((await db.collection('runner_jobs').doc(jobId).get()).data()!.completedAt, '2026-09-20T12:05:00.000Z');
});
