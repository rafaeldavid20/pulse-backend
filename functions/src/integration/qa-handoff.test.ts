import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { dispatchPendingQa, qaCapacityTrigger, retryPendingQa } from '../triggers/qa-dispatch';
import { runnerJobSigningPrivateKey } from '../common/secrets';
import { todayKey } from '../common/utils/dispatch-counter';
import * as github from '../github/client';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
runnerJobSigningPrivateKey.value = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let headSha = 'a'.repeat(40);
mock.method(github, 'getPullRequestOrigin', async (_: string, repo: string) => ({ headSha, headRef: 'pul/test', headRepoFullName: repo, baseRepoFullName: repo, state: 'open', merged: false, draft: false }));

async function fixture(identifier = 'TES-341', qaMode = 'shadow') {
  const suffix = randomBytes(6).toString('hex');
  const ws = `ws-handoff-${suffix}`, id = `issue-${suffix}`, project = `project-${suffix}`, qa = `qa-${suffix}`, runner = `runner-${suffix}`, devJob = `dev-${suffix}`;
  const now = new Date().toISOString();
  await Promise.all([
    db.collection('workspaces').doc(ws).set({ dailyDispatchLimit: 20, maxRunsPerIssue: 20 }),
    db.collection('issues').doc(id).set({ identifier, workspaceId: ws, projectId: project, status: 'in_review', execution: { agentId: 'dev' }, git: { repoFullName: 'owner/repo', prNumber: 1, prState: 'open', branch: 'pul/test' } }),
    db.collection('projects').doc(project).set({ workspaceId: ws, repoFullNames: ['owner/repo'] }),
    db.collection('github_installations').doc(ws).set({ workspaceId: ws, installationId: ws, repositoryFullNames: ['owner/repo'] }),
    db.collection('agents').doc(qa).set({ workspaceId: ws, role: 'qa', kind: 'codex', enabled: true, autonomousMode: true, maxReviewAttempts: 2, runnerId: runner, qaMode }),
    db.collection('runners').doc(runner).set({ workspaceId: ws, status: 'online', maxConcurrentJobs: 1, lastHeartbeatAt: now, readinessCheckedAt: now, readiness: { workspaceId: ws, jobProtocolVersion: 2, qaSourceProtocolVersion: 1, identities: [{ agentId: 'dev', kind: 'codex', role: 'dev' }, { agentId: qa, kind: 'codex', role: 'qa' }], providers: { codex: { cli: true, session: true } } } }),
    db.collection('runner_jobs').doc(devJob).set({ workspaceId: ws, runnerId: runner, issueId: id, agentId: 'dev', mode: 'task', status: 'delivered', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  ]);
  return { ws, id, qa, runner, devJob };
}
const current = async (f: any) => (await db.collection('issues').doc(f.id).get()).data()!;
const qaJobs = async (f: any) => (await db.collection('runner_jobs').where('issueId', '==', f.id).get()).docs.filter(d => d.data().mode === 'review');
const spent = async (f: any) => (await db.collection('agent_dispatch_counters').doc(`${f.ws}_${todayKey()}`).get()).data()?.count || 0;
async function complete(f: any) {
  const before = (await db.collection('runner_jobs').doc(f.devJob).get()).data()!;
  await db.collection('runner_jobs').doc(f.devJob).update({ status: 'completed' });
  const event = { data: { before: { data: () => before }, after: { data: () => ({ ...before, status: 'completed' }) } } } as any;
  await Promise.all([qaCapacityTrigger.run(event), qaCapacityTrigger.run(event), retryPendingQa(f.ws, f.runner)]);
}
for (const [identifier, mode] of [['TES-340', 'shadow'], ['TES-341', 'enforce']]) {
  test(`${identifier}: delayed dev publication, repeated events and one shared Runner issue one signed QA job (${mode})`, async () => {
    const f = await fixture(identifier, mode);
    await Promise.all([dispatchPendingQa(f.id), dispatchPendingQa(f.id)]);
    await new Promise(resolve => setTimeout(resolve, 40));
    await dispatchPendingQa(f.id);
    let issue = await current(f);
    assert.equal(issue.review.dispatchPending.reason, 'capacity');
    assert.equal(issue.review.attempt, undefined);
    assert.equal((await qaJobs(f)).length, 0); assert.equal(await spent(f), 0);
    headSha = 'b'.repeat(40);
    await complete(f);
    const jobs = await qaJobs(f); assert.equal(jobs.length, 1);
    assert.equal(jobs[0].data().agentId, f.qa); assert.ok(jobs[0].data().signature);
    assert.deepEqual(jobs[0].data().contextRepos, ['owner/repo']);
    assert.equal(await spent(f), 1);
    issue = await current(f); assert.equal(issue.review.dispatchPending, undefined);
    assert.equal(issue.review.attempt, undefined); assert.match(issue.review.dispatchedContext, /bbbbbbbb/);
    assert.equal((await db.collection('agents').doc(f.qa).get()).data()?.qaMode, mode);
    // Even late entry events after job completion cannot duplicate this context.
    await jobs[0].ref.update({ status: 'completed' });
    await db.collection('issues').doc(f.id).update({ 'review.dispatchedAt': '2000-01-01T00:00:00.000Z' });
    await Promise.all([dispatchPendingQa(f.id), dispatchPendingQa(f.id)]);
    assert.equal((await qaJobs(f)).length, 1); assert.equal(await spent(f), 1);
  });
}
for (const mutation of ['cancel', 'close', 'permissions', 'budget', 'attempts', 'disabled', 'autonomous', 'preflight']) {
  test(`pending QA revalidates ${mutation} on capacity release`, async () => {
    const f = await fixture(); await dispatchPendingQa(f.id);
    if (mutation === 'cancel') await db.collection('issues').doc(f.id).update({ status: 'canceled' });
    if (mutation === 'close') await db.collection('issues').doc(f.id).update({ 'git.prState': 'closed' });
    if (mutation === 'permissions') await db.collection('github_installations').doc(f.ws).update({ repositoryFullNames: [] });
    if (mutation === 'budget') await db.collection('workspaces').doc(f.ws).update({ dailyDispatchLimit: 0 });
    if (mutation === 'attempts') await db.collection('issues').doc(f.id).update({ 'review.attempt': 2 });
    if (mutation === 'autonomous') await db.collection('agents').doc(f.qa).update({ autonomousMode: false });
    if (mutation === 'disabled') await db.collection('agents').doc(f.qa).update({ enabled: false });
    if (mutation === 'preflight') await db.collection('runners').doc(f.runner).update({ 'readiness.providers.codex.session': false });
    await complete(f); assert.equal((await qaJobs(f)).length, 0); assert.equal(await spent(f), 0);
    if (mutation === 'preflight') assert.match((await current(f)).review.dispatchError, /codex login/);
  });
}
test('scheduler recovers a completion that happened before the waiting write', async () => {
  const f = await fixture(); await dispatchPendingQa(f.id);
  await db.collection('runner_jobs').doc(f.devJob).update({ status: 'completed' });
  await retryPendingQa(f.ws); assert.equal((await qaJobs(f)).length, 1);
});

test('legacy capacity diagnostic recovers without toggling issue status', async () => {
  const f = await fixture();
  await db.collection('issues').doc(f.id).update({ 'review.dispatchError': 'El Runner QA alcanzó su límite de jobs activos. Volvé a despachar QA cuando tenga capacidad.' });
  await db.collection('runner_jobs').doc(f.devJob).update({ status: 'completed' });
  await retryPendingQa(f.ws);
  assert.equal((await qaJobs(f)).length, 1);
  assert.equal((await current(f)).review.dispatchError, undefined);
});
test('waiting handoff uses changed PR set and new live SHA', async () => {
  const f = await fixture(); await dispatchPendingQa(f.id);
  await db.collection('issues').doc(f.id).update({ 'git.prNumber': 2 });
  headSha = 'c'.repeat(40);
  await complete(f);
  assert.equal((await qaJobs(f)).length, 1);
  const context = JSON.parse((await current(f)).review.dispatchedContext);
  assert.deepEqual(context[2], [['owner/repo', 2, headSha]]);
});
