import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AssignExecutionAgentAction } from '../actions/issues/assign-execution-agent';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firebase Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
let sequence = 0;

async function fixture() {
  const suffix = `executor-${Date.now()}-${++sequence}`;
  const workspaceId = `ws-${suffix}`;
  const owner = `owner-${suffix}`;
  const agentId = `agent-${suffix}`;
  const projectId = `project-${suffix}`;
  const issueId = `issue-${suffix}`;
  await db.collection('members').doc(`${workspaceId}_${owner}`).set({ workspaceId, userId: owner, role: 'member' });
  await db.collection('agents').doc(agentId).set({ workspaceId, ownerMemberId: owner, visibility: 'personal', runnerId: `runner-${suffix}`, enabled: true });
  await db.collection('projects').doc(projectId).set({ workspaceId, repoFullNames: ['test/app', 'test/backend'] });
  await db.collection('github_installations').doc(suffix).set({ workspaceId, repositoryFullNames: ['test/app', 'test/backend', 'test/other'] });
  const issue = db.collection('issues').doc(issueId);
  await issue.set({ workspaceId, responsibleMemberId: owner, assigneeId: owner, projectId, status: 'todo' });
  const assign = (selected: string | undefined = agentId, caller = owner) => new AssignExecutionAgentAction({
    actionCode: 'issues.assignExecutionAgent', data: { issueId, agentId: selected },
  }, caller).run();
  return { workspaceId, owner, agentId, projectId, issue, assign, installationId: suffix };
}

test('TES-346: missing project rejects assignment without changing the issue or creating a job', async () => {
  const f = await fixture();
  await f.issue.update({ projectId: null });
  const before = (await f.issue.get()).data();
  const result = await f.assign();
  assert.equal(result.success, false);
  assert.match(result.error || '', /Elegí un proyecto/);
  assert.deepEqual((await f.issue.get()).data(), before);
  assert.equal((await db.collection('runner_jobs').where('workspaceId', '==', f.workspaceId).get()).empty, true);
});

test('TES-346: configured project resolves the default repo and preserves the human owner', async () => {
  const f = await fixture();
  const result = await f.assign();
  assert.equal(result.success, true);
  const issue = (await f.issue.get()).data()!;
  assert.equal(issue.execution.agentId, f.agentId);
  assert.equal(issue.responsibleMemberId, f.owner);
  assert.equal(issue.assigneeId, f.owner);
  assert.equal(issue.status, 'todo');
});

test('TES-346: explicit repo outside the project is rejected even when installed', async () => {
  const f = await fixture();
  await f.issue.update({ git: { repoFullName: 'test/other' } });
  const result = await f.assign();
  assert.equal(result.success, false);
  assert.match(result.error || '', /pertenezca al proyecto/);
  assert.equal((await f.issue.get()).data()?.execution, undefined);
});

test('TES-346: valid inherited epic repo is accepted; revoked repo is rejected', async () => {
  const f = await fixture();
  const epicId = `epic-${f.agentId}`;
  await db.collection('issues').doc(epicId).set({ workspaceId: f.workspaceId, git: { repoFullName: 'test/backend' } });
  await f.issue.update({ epicId });
  assert.equal((await f.assign()).success, true);
  await db.collection('github_installations').doc(f.installationId).update({ repositoryFullNames: ['test/app'] });
  const before = (await f.issue.get()).data();
  assert.equal((await f.assign()).success, false);
  assert.deepEqual((await f.issue.get()).data(), before);
});

test('TES-346: missing, foreign or empty project and suspended installation cannot authorize assignment', async () => {
  for (const scenario of ['missing', 'foreign', 'empty', 'suspended']) {
    const f = await fixture();
    const project = db.collection('projects').doc(f.projectId);
    if (scenario === 'missing') await project.delete();
    if (scenario === 'foreign') await project.update({ workspaceId: 'another-workspace' });
    if (scenario === 'empty') await project.update({ repoFullNames: [] });
    if (scenario === 'suspended') await db.collection('github_installations').doc(f.installationId).update({ suspendedAt: new Date().toISOString() });
    assert.equal((await f.assign()).success, false, scenario);
    assert.equal((await f.issue.get()).data()?.execution, undefined, scenario);
  }
});

test('TES-346: another member cannot assign the owner agent, even with valid routing', async () => {
  const f = await fixture();
  const other = `other-${f.agentId}`;
  await db.collection('members').doc(`${f.workspaceId}_${other}`).set({ workspaceId: f.workspaceId, userId: other, role: 'member' });
  assert.equal((await f.assign(f.agentId, other)).success, false);
  assert.equal((await f.issue.get()).data()?.execution, undefined);
});

test('TES-346: removing the executor remains possible with invalid routing', async () => {
  const f = await fixture();
  await f.issue.update({ projectId: null, execution: { agentId: f.agentId } });
  const result = await new AssignExecutionAgentAction({
    actionCode: 'issues.assignExecutionAgent', data: { issueId: f.issue.id },
  }, f.owner).run();
  assert.equal(result.success, true);
  assert.equal((await f.issue.get()).data()?.execution, null);
});
