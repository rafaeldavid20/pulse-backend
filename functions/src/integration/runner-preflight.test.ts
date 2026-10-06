import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PreflightAgentAction } from '../actions/runners/preflight-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
async function fixture(role = 'dev') {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const workspaceId = `ws-pf-${suffix}`; const agentId = `agent-${suffix}`; const runnerId = `runner-${suffix}`;
  const owner = `owner-${suffix}`; const other = `other-${suffix}`; const admin = `admin-${suffix}`;
  for (const [id, memberRole] of [[owner, 'member'], [other, 'member'], [admin, 'admin']]) await db.collection('members').doc(`${workspaceId}_${id}`).set({ workspaceId, userId: id, role: memberRole });
  await db.collection('agents').doc(agentId).set({ id: agentId, workspaceId, ownerMemberId: owner, visibility: 'personal', enabled: true, kind: 'codex', role, runnerId, allowedRepos: ['owner/repo'] });
  await db.collection('runners').doc(runnerId).set({ id: runnerId, workspaceId, ownerMemberId: owner, status: 'online', maxConcurrentJobs: 1, connectedRepos: ['owner/repo'], lastHeartbeatAt: new Date().toISOString(), readinessCheckedAt: new Date().toISOString(), readiness: { workspaceId, jobProtocolVersion: 2, identities: [{ agentId, kind: 'codex', role }], providers: { codex: { cli: true, session: true } }, repositories: [{ repo: 'owner/repo', accessible: true }] } });
  await db.collection('projects').doc(workspaceId).set({workspaceId,repoFullNames:['owner/repo']});
  await db.collection('github_installations').doc(workspaceId).set({workspaceId,repositoryFullNames:['owner/repo']});
  return { workspaceId, agentId, runnerId, owner, other, admin };
}
test('preflight rejects unrelated members and cross-workspace Runner details', async () => {
  const f = await fixture();
  const request = { actionCode: 'runners.preflight' as const, data: { agentId: f.agentId, repos: ['owner/repo'] } };
  assert.equal((await new PreflightAgentAction(request, f.other).run()).success, false);
  const owner = await new PreflightAgentAction(request, f.owner).run();
  assert.equal(owner.success, true); assert.equal(owner.data?.ready, true);
  assert.equal((await new PreflightAgentAction(request, f.admin).run()).success, true);
  await db.collection('runners').doc(f.runnerId).update({ workspaceId: 'other-workspace' });
  const denied = await new PreflightAgentAction(request, f.admin).run();
  assert.equal(denied.success, false); assert.equal(denied.data, undefined);
  assert.equal((await new UpdateAgentAction({ actionCode: 'agents.update', data: { agentId: f.agentId, runnerId: f.runnerId } }, f.owner).run()).success, false);
});
test('concurrent dispatches respect Runner capacity and changed identities prevent writes', async () => {
  const f = await fixture();
  const input = { workspaceId: f.workspaceId, agentId: f.agentId, runnerId: f.runnerId, issueId: 'issue-pf', repoFullName: 'owner/repo', mode: 'task' as const };
  await db.collection('issues').doc(input.issueId).set({ workspaceId: f.workspaceId, projectId: f.workspaceId });
  const results = await Promise.allSettled([enqueueRunnerJob(db, input, privateKey), enqueueRunnerJob(db, input, privateKey)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await db.collection('runner_jobs').where('runnerId', '==', f.runnerId).get()).size, 1);
  await db.collection('runners').doc(f.runnerId).update({ 'readiness.identities': [{ agentId: 'other-agent', kind: 'codex', role: 'dev' }] });
  await assert.rejects(enqueueRunnerJob(db, input, privateKey), /identidad local/);
  assert.equal((await db.collection('runner_jobs').where('runnerId', '==', f.runnerId).get()).size, 1);
});
test('QA jobs require explicit QA identity and repositories from the issue PRs', async () => {
  const f = await fixture('qa'); const issueId = `issue-${f.agentId}`;
  const input = { workspaceId: f.workspaceId, agentId: f.agentId, runnerId: f.runnerId, issueId, repoFullName: 'owner/repo', mode: 'review' as const };
  await db.collection('issues').doc(issueId).set({ workspaceId: f.workspaceId, projectId: f.workspaceId, git: { repoFullName: 'owner/other', prNumber: 1 } });
  await assert.rejects(enqueueRunnerJob(db, input, privateKey), /contexto de revisión/);
  await db.collection('issues').doc(issueId).update({ git: { repoFullName: 'owner/repo', prNumber: 1 } });
  assert.ok((await enqueueRunnerJob(db, input, privateKey)).id);
});
