import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ReviewsRerunAction } from '../actions/reviews/rerun-review';
import { ReviewsStartAction } from '../actions/reviews/start-review';
import { ReviewsSubmitAction } from '../actions/reviews/submit-review';
import { runnerJobSigningPrivateKey } from '../common/secrets';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { reviewRequestRefs } from '../common/utils/review-request';
import { todayKey } from '../common/utils/dispatch-counter';
import { qaDispatchTrigger } from '../triggers/qa-dispatch';
import { agentDispatchTrigger } from '../triggers/agent-dispatch';
import * as github from '../github/client';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
runnerJobSigningPrivateKey.value = () => privateKey;
mock.method(github, 'getPullRequestOrigin', async (_: string, repo: string, number: number) => ({ headSha: String(number).repeat(40), headRef: 'pul/corrected', headRepoFullName: repo, baseRepoFullName: repo }));
mock.method(github, 'getPullRequestHeadSha', async (_: string, __: string, number: number) => String(number).repeat(40));
mock.method(github, 'createPullRequestReview', async () => undefined);

async function fixture(mode = 'shadow') {
  const suffix = randomBytes(7).toString('hex');
  const ws = `ws-manual-${suffix}`, id = `issue-${suffix}`, project = `project-${suffix}`, qa = `qa-${suffix}`, runner = `runner-${suffix}`, human = `human-${suffix}`;
  const now = new Date().toISOString();
  const refs = ['owner/app', 'owner/backend'].map((repoFullName, i) => ({ repoFullName, prNumber: i + 1, prState: i ? 'merged' : 'open', branch: 'pul/corrected' }));
  const previous = { state: 'changes_requested', attempt: 1, verdict: 'Primera revisión rechazada', findings: [{ id: 'old', severity: 'major', status: 'open', message: 'Old finding' }] };
  const review = { state: 'needs_human', attempt: 2, reviewerId: qa, verdict: 'Segunda revisión rechazada', findings: [{ id: 'second', severity: 'major', status: 'fixed', message: 'Corregido en nuevo head' }], history: [previous], prs: refs.map(r => ({ ...r, headSha: 'a'.repeat(40) })) };
  const issue = { id, identifier: 'INT-334', workspaceId: ws, projectId: project, teamId: 'team-test', status: 'in_progress', assigneeId: human, responsibleMemberId: human, execution: { agentId: `dev-${suffix}`, mode: 'personal' }, qaAssigneeId: qa, git: refs[0], gitRefs: refs, review, acceptanceCriteria: [{ id: 'criterion', text: 'Funciona' }] };
  await Promise.all([
    db.collection('workspaces').doc(ws).set({ dailyDispatchLimit: 50, maxRunsPerIssue: 50 }),
    db.collection('members').doc(`${ws}_${human}`).set({ workspaceId: ws, userId: human, role: 'member' }),
    db.collection('members').doc(`${ws}_${qa}`).set({ workspaceId: ws, userId: qa, role: 'member', isAgent: true }),
    db.collection('issues').doc(id).set(issue),
    db.collection('projects').doc(project).set({ workspaceId: ws, repoFullNames: refs.map(r => r.repoFullName), leadId: human }),
    db.collection('github_installations').doc(ws).set({ workspaceId: ws, installationId: ws, repositoryFullNames: refs.map(r => r.repoFullName) }),
    db.collection('agents').doc(qa).set({ workspaceId: ws, role: 'qa', kind: 'codex', enabled: true, autonomousMode: true, maxReviewAttempts: 2, runnerId: runner, qaMode: mode }),
    db.collection('runners').doc(runner).set({ workspaceId: ws, status: 'online', maxConcurrentJobs: 10, lastHeartbeatAt: now, readinessCheckedAt: now, readiness: { workspaceId: ws, jobProtocolVersion: 2, qaSourceProtocolVersion: 1, identities: [{ agentId: qa, kind: 'codex', role: 'qa' }], providers: { codex: { cli: true, session: true } } } }),
    db.collection('qa_source_preflights').doc(`${id}_${qa}`).set({ workspaceId: ws, projectId: project, checkedAt: now, repositories: refs.map(r => ({ repo: r.repoFullName, sha: String(r.prNumber).repeat(40), prNumber: r.prNumber })), downloaded: Object.fromEntries(refs.map(r => [r.repoFullName, String(r.prNumber).repeat(40)])) }),
  ]);
  return { ws, id, project, qa, runner, human, issue };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, caller = f.human) => new ReviewsRerunAction({ actionCode: 'reviews.rerun', data: { issueId: f.id } }, caller).run();
const start = (f: Fixture) => new ReviewsStartAction({ actionCode: 'reviews.start', data: { workspaceId: f.ws, issueId: f.id } }, f.qa).run();
const current = async (f: Fixture) => (await db.collection('issues').doc(f.id).get()).data()!;
const jobs = async (f: Fixture) => (await db.collection('runner_jobs').where('issueId', '==', f.id).get()).docs;
const spent = async (f: Fixture) => (await db.collection('agent_dispatch_counters').doc(`${f.ws}_${todayKey()}`).get()).data()?.count || 0;
async function submit(f: Fixture, fail = false) {
  const result = await new ReviewsSubmitAction({ actionCode: 'reviews.submit', data: { issueId: f.id, verdict: fail ? 'Rechazado' : 'Aprobado', findings: [], criteriaResults: [{ criterionId: 'criterion', result: fail ? 'fail' : 'pass', evidence: 'Tests locales' }] } }, f.qa).run();
  assert.equal(result.success, true, JSON.stringify(result));
  for (const job of await jobs(f)) await job.ref.update({ status: 'completed' });
}
async function auto(f: Fixture) {
  const after = await current(f);
  await qaDispatchTrigger.run({ params: { issueId: f.id }, data: { before: { data: () => ({ ...after, status: 'todo' }) }, after: { data: () => ({ ...after, status: 'in_review' }) } } } as any);
  await agentDispatchTrigger.run({ params: { issueId: f.id }, data: { before: { data: () => ({ ...after, review: { ...after.review, state: 'running' } }) }, after: { data: () => after } } } as any);
}
for (const mode of ['shadow', 'enforce']) test(`exhausted attempts allow repeated explicit QA (${mode}) over all new heads with history and requester`, async () => {
  const f = await fixture(mode);
  await auto(f); assert.equal((await jobs(f)).length, 0);
  const result = await request(f); assert.equal(result.success, true, JSON.stringify(result));
  const run = (await db.collection('agent_runs').doc(result.data!.jobId).get()).data()!;
  assert.equal(run.requestedBy, f.human); assert.equal(run.requestSource, 'manual'); assert.equal(run.reviewAttempt, 3);
  assert.deepEqual((await jobs(f))[0].data().contextRepos, ['owner/app', 'owner/backend']);
  assert.deepEqual((await current(f)).review.findings, f.issue.review.findings);
  assert.equal((await current(f)).review.attempt, 2);
  assert.equal((await start(f)).data?.attempt, 3);
  assert.equal((await start(f)).data?.attempt, 3, 'resuming a manual claim preserves its attempt');
  let issue = await current(f);
  assert.equal(issue.status, 'in_progress'); assert.equal(issue.assigneeId, f.human);
  assert.equal(issue.review.requestSource, 'manual'); assert.equal(issue.review.requestedBy, f.human);
  assert.equal(issue.review.history.length, 2); assert.equal(issue.review.history[1].verdict, f.issue.review.verdict);
  assert.deepEqual(issue.review.prs.map((p: any) => p.headSha), ['1'.repeat(40), '2'.repeat(40)]);
  await submit(f);
  assert.equal((await current(f)).review.state, 'approved');
  assert.equal((await current(f)).review.requestedBy, f.human);
  const second = await request(f); assert.equal(second.success, true, JSON.stringify(second));
  assert.equal((await start(f)).data?.attempt, 4);
  await submit(f, true); await auto(f);
  issue = await current(f);
  assert.equal(issue.review.state, 'needs_human'); assert.equal(issue.review.attempt, 4);
  assert.equal(issue.review.history.length, 3); assert.equal(issue.review.history[2].requestSource, 'manual');
  assert.equal((await jobs(f)).length, 2); assert.equal(await spent(f), 2);
  assert.equal((await db.collection('agents').doc(f.qa).get()).data()?.maxReviewAttempts, 2);
  assert.equal((await db.collection('agents').doc(f.qa).get()).data()?.qaMode, mode);
});
test('concurrent manual and automatic dispatches emit one job and one budget reservation', async () => {
  const f = await fixture(); await db.collection('issues').doc(f.id).update({ status: 'in_review', 'review.attempt': 1, 'review.state': 'changes_requested' });
  const results = await Promise.all([request(f), request(f), auto(f)]);
  assert.equal((await jobs(f)).length, 1); assert.equal(await spent(f), 1);
  assert.ok(results.some(r => r?.success) || (await jobs(f)).length === 1);
  assert.equal((await request(f)).success, false);
});
test('active dev job on another Runner, active QA claim and denied humans/agents consume nothing', async () => {
  for (const scenario of ['job', 'claim', 'foreign', 'agent', 'missing-member']) {
    const f = await fixture(); let caller = f.human;
    if (scenario === 'job') await db.collection('runner_jobs').doc(f.id + '-dev').set({ issueId: f.id, runnerId: 'other', mode: 'task', status: 'delivered', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (scenario === 'claim') await db.collection('issues').doc(f.id).update({ 'review.state': 'running', 'review.claimedBy': f.qa });
    if (scenario === 'foreign') caller = 'foreign';
    if (scenario === 'agent') caller = f.qa;
    if (scenario === 'missing-member') await db.collection('members').doc(`${f.ws}_${f.human}`).delete();
    const before = await current(f);
    assert.equal((await request(f, caller)).success, false);
    assert.deepEqual(await current(f), before); assert.equal(await spent(f), 0);
  }
});
for (const scenario of ['preflight', 'signing', 'paused', 'daily-limit', 'issue-limit', 'issue-cost', 'workspace-cost', 'closed-pr', 'pending-work']) test(`${scenario} failure leaves no reservation and permits retry`, async () => {
  const f = await fixture(); const before = await current(f);
  if (scenario === 'preflight') await db.collection('runners').doc(f.runner).update({ readinessCheckedAt: '2000-01-01T00:00:00Z' });
  if (scenario === 'signing') runnerJobSigningPrivateKey.value = () => 'invalid-test-key';
  if (scenario === 'paused') await db.collection('workspaces').doc(f.ws).update({ agentsPaused: true });
  if (scenario === 'daily-limit') await db.collection('workspaces').doc(f.ws).update({ dailyDispatchLimit: 0 });
  if (scenario === 'issue-limit') await db.collection('workspaces').doc(f.ws).update({ maxRunsPerIssue: 0 });
  if (['issue-cost', 'workspace-cost'].includes(scenario)) {
    await db.collection('agent_runs').doc(f.id + '-old').set({ workspaceId: f.ws, issueId: f.id, date: todayKey(), costUsd: 2 });
    await db.collection('workspaces').doc(f.ws).update(scenario === 'issue-cost' ? { issueCostCapUsd: 1 } : { dailyCostCapUsd: 1 });
  }
  if (scenario === 'closed-pr') await db.collection('issues').doc(f.id).update({ gitRefs: [{ ...f.issue.gitRefs[0], prState: 'closed' }] });
  if (scenario === 'pending-work') await db.collection('issues').doc(f.id).update({ pendingRepoWork: [{ repoFullName: 'owner/backend' }] });
  const result = await request(f); assert.equal(result.success, false); assert.ok(result.error);
  assert.equal((await jobs(f)).length, 0); assert.equal(await spent(f), 0);
  assert.deepEqual((await current(f)).review, before.review);
  runnerJobSigningPrivateKey.value = () => privateKey;
  await db.collection('workspaces').doc(f.ws).set({ dailyDispatchLimit: 50, maxRunsPerIssue: 50 });
  await db.collection('runners').doc(f.runner).update({ readinessCheckedAt: new Date().toISOString() });
  await db.collection('issues').doc(f.id).set(before);
  assert.equal((await request(f)).success, true);
});
test('enqueue revalidates changed PR identity and revoked human membership atomically', async () => {
  for (const scenario of ['pr', 'permission']) {
    const f = await fixture();
    if (scenario === 'pr') await db.collection('issues').doc(f.id).update({ gitRefs: [{ ...f.issue.gitRefs[0], prNumber: 99 }] });
    else await db.collection('members').doc(`${f.ws}_${f.human}`).delete();
    await assert.rejects(enqueueRunnerJob(db, { workspaceId: f.ws, issueId: f.id, agentId: f.qa, runnerId: f.runner, repoFullName: 'owner/app', contextRepos: ['owner/app', 'owner/backend'], mode: 'review' }, privateKey, 'runner-job-v1', { mode: 'review', attempt: 2, refs: reviewRequestRefs(f.issue), requestedBy: f.human }));
    assert.equal((await jobs(f)).length, 0); assert.equal(await spent(f), 0);
  }
});

test('a completed incomplete review with an old claim can be reviewed manually without losing results', async () => {
  const f = await fixture();
  await db.collection('issues').doc(f.id).update({ 'review.claimedBy': f.qa, 'review.claimedAt': new Date().toISOString() });
  assert.equal((await request(f)).success, true);
  assert.equal((await start(f)).data?.attempt, 3);
  assert.equal((await current(f)).review.history[1].verdict, f.issue.review.verdict);
});
test('expired manual jobs cannot authorize a claim; a new explicit request can retry', async () => {
  const f = await fixture(); assert.equal((await request(f)).success, true);
  const first = (await jobs(f))[0]; await first.ref.update({ status: 'expired', expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal((await start(f)).success, false); assert.equal((await current(f)).review.attempt, 2);
  assert.equal((await request(f)).success, true); assert.equal((await start(f)).data?.attempt, 3);
  assert.equal((await current(f)).review.history.length, 2);
});
