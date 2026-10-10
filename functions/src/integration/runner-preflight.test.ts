import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { PreflightAgentAction } from '../actions/runners/preflight-agent';
import { UpdateAgentAction } from '../actions/agents/update-agent';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { reportDispatchFailure, RunnerDispatchError } from '../common/utils/dispatch-failure';
import { todayKey } from '../common/utils/dispatch-counter';
import { agentDispatchTrigger } from '../triggers/agent-dispatch';
import { runnerJobSigningPrivateKey } from '../common/secrets';
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
  await db.collection('runners').doc(runnerId).set({ id: runnerId, workspaceId, ownerMemberId: owner, status: 'online', maxConcurrentJobs: 1, connectedRepos: ['owner/repo'], lastHeartbeatAt: new Date().toISOString(), readinessCheckedAt: new Date().toISOString(), readiness: { workspaceId, jobProtocolVersion: 2, qaSourceProtocolVersion: 1, identities: [{ agentId, kind: 'codex', role }], providers: { codex: { cli: true, session: true } }, repositories: [{ repo: 'owner/repo', accessible: true }] } });
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

async function taskFixture() {
  const f = await fixture();
  const issueId = `issue-${f.agentId}`;
  await db.collection('issues').doc(issueId).set({ workspaceId: f.workspaceId, projectId: f.workspaceId, status: 'todo', execution: { agentId: f.agentId } });
  const input = { workspaceId: f.workspaceId, agentId: f.agentId, runnerId: f.runnerId, issueId, repoFullName: 'owner/repo', mode: 'task' as const };
  return { ...f, issueId, input, emit: (key = privateKey) => enqueueRunnerJob(db, input, key, 'runner-job-v1', true) };
}

async function counts(f: Awaited<ReturnType<typeof taskFixture>>) {
  return {
    jobs: (await db.collection('runner_jobs').where('issueId', '==', f.issueId).get()).size,
    runs: (await db.collection('agent_runs').where('issueId', '==', f.issueId).get()).size,
    budget: (await db.collection('agent_dispatch_counters').doc(`${f.workspaceId}_${todayKey()}`).get()).data()?.count || 0,
  };
}

// Trigger snapshots come from actual persisted transitions, including retries
// where review.state remains changes_requested throughout.
async function transition(issueId: string, update: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>) {
  const ref = db.collection('issues').doc(issueId);
  const before = await ref.get();
  await ref.update(update);
  const after = await ref.get();
  const event = { params: { issueId }, data: { before, after } };
  await agentDispatchTrigger.run(event as any);
  return event;
}

test('failed task preflight records safe reasons, spends nothing, and correction retries immediately', async () => {
  const f = await taskFixture();
  await db.collection('runners').doc(f.runnerId).update({ readinessCheckedAt: '2000-01-01T00:00:00.000Z', 'readiness.providers.codex.session': false });
  const startedAt = new Date().toISOString();
  await assert.rejects(f.emit(), (error: unknown) => {
    assert.ok(error instanceof RunnerDispatchError);
    assert.equal(error.stage, 'preflight');
    return true;
  });
  try { await f.emit(); } catch (error) { await reportDispatchFailure(db, f.issueId, f.agentId, startedAt, error); }
  const failed = (await db.collection('issues').doc(f.issueId).get()).data()!;
  assert.equal(failed.agent.dispatchedAt, undefined);
  assert.equal(failed.agent.dispatchedTo, undefined);
  assert.equal(failed.agent.dispatchFailure.stage, 'preflight');
  assert.match(failed.agent.dispatchFailure.reasons.join(' '), /diagnose/);
  assert.match(failed.agent.dispatchFailure.reasons.join(' '), /codex login/);
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
  await db.collection('runners').doc(f.runnerId).update({ readinessCheckedAt: new Date().toISOString(), 'readiness.providers.codex.session': true });
  await f.emit();
  const success = (await db.collection('issues').doc(f.issueId).get()).data()!;
  assert.equal(success.agent.dispatchFailure, undefined);
  assert.equal(success.agent.blockedReason, undefined);
  assert.equal(success.agent.state, 'idle');
  assert.ok(success.agent.dispatchedAt);
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
});

test('concurrent same-issue task dispatch emits one job even with spare Runner capacity', async () => {
  const f = await taskFixture();
  await db.collection('runners').doc(f.runnerId).update({ maxConcurrentJobs: 10 });
  const results = await Promise.allSettled([f.emit(), f.emit(), f.emit()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
  // A later losing attempt must not replace successful state with an error.
  await reportDispatchFailure(db, f.issueId, f.agentId, new Date().toISOString(), new Error('untrusted transport details'));
  assert.equal((await db.collection('issues').doc(f.issueId).get()).data()!.agent.dispatchFailure, undefined);
  await assert.rejects(f.emit());
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
  await db.collection('issues').doc(f.issueId).update({ 'agent.dispatchedAt': new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  await assert.rejects(f.emit(), (error: any) => error.silent === true);
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
});

test('enqueue signing and budget failures leave no dispatch reservation or spend', async () => {
  const f = await taskFixture();
  await assert.rejects(f.emit('invalid signing material'));
  await reportDispatchFailure(db, f.issueId, f.agentId, new Date().toISOString(), new Error('untrusted transport details'));
  const diagnostic = (await db.collection('issues').doc(f.issueId).get()).data()!.agent.dispatchFailure;
  assert.equal(diagnostic.stage, 'enqueue');
  assert.doesNotMatch(JSON.stringify(diagnostic), /untrusted transport details/);
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
  await db.collection('workspaces').doc(f.workspaceId).set({ agentsPaused: true });
  await assert.rejects(f.emit(), (error: any) => error.stage === 'budget');
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
  await db.collection('workspaces').doc(f.workspaceId).update({ agentsPaused: false });
  await f.emit();
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
});

test('failure while enqueueing after queued budget writes rolls back the entire transaction', async () => {
  const f = await taskFixture();
  const failingDb = {
    collection: db.collection.bind(db),
    runTransaction: (work: any) => db.runTransaction((tx) => work(new Proxy(tx, {
      get(target, key) {
        if (key === 'create') return (ref: any, value: any) => {
          if (ref.parent.id === 'runner_jobs') throw new Error('Injected enqueue failure');
          return target.create(ref, value);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }))),
  } as any;
  await assert.rejects(enqueueRunnerJob(failingDb, f.input, privateKey, 'runner-job-v1', true), /Injected enqueue failure/);
  const issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
  assert.equal(issue.agent?.dispatchedAt, undefined);
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
  await f.emit();
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
});

test('real task trigger reports preflight failure and a new todo transition retries without cooldown', async () => {
  const f = await taskFixture();
  await db.collection('agents').doc(f.agentId).update({ autonomousMode: true });
  await db.collection('issues').doc(f.issueId).update({ responsibleMemberId: f.owner, git: { repoFullName: 'owner/repo' } });
  await db.collection('runners').doc(f.runnerId).update({ readinessCheckedAt: '2000-01-01T00:00:00.000Z' });
  const original = runnerJobSigningPrivateKey.value;
  runnerJobSigningPrivateKey.value = () => privateKey;
  try {
    const dispatch = async () => {
      const after = (await db.collection('issues').doc(f.issueId).get()).data()!;
      await agentDispatchTrigger.run({ params: { issueId: f.issueId }, data: {
        before: { data: () => ({ ...after, status: 'backlog' }) }, after: { data: () => after },
      } } as any);
    };
    await dispatch();
    const failed = (await db.collection('issues').doc(f.issueId).get()).data()!;
    assert.equal(failed.agent.dispatchFailure.stage, 'preflight');
    assert.equal(failed.agent.dispatchedAt, undefined);
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
    await db.collection('runners').doc(f.runnerId).update({ readinessCheckedAt: new Date().toISOString(), maxConcurrentJobs: 10 });
    await Promise.all([dispatch(), dispatch()]);
    assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
    assert.equal((await db.collection('issues').doc(f.issueId).get()).data()!.agent.dispatchFailure, undefined);
  } finally {
    runnerJobSigningPrivateKey.value = original;
  }
});


test('rework recovery keeps the QA attempt and finding repo across real status transitions', async () => {
  const f = await taskFixture();
  const ref = db.collection('issues').doc(f.issueId);
  await db.collection('agents').doc(f.agentId).update({ autonomousMode: true });
  // An actual task was emitted recently, so a task retry would hit cooldown.
  const task = await f.emit();
  await db.collection('runner_jobs').doc(task.id).update({ status: 'completed' });
  await ref.update({ status: 'in_progress', responsibleMemberId: f.owner,
    git: { repoFullName: 'owner/repo' }, gitRefs: [
      { repoFullName: 'owner/repo', branch: 'pul/int-repo', prNumber: 1, prState: 'open' },
      { repoFullName: 'owner/finding', branch: 'pul/int-finding', prNumber: 2, prState: 'open' },
    ], review: { state: 'pending', attempt: 1 } });
  await db.collection('projects').doc(f.workspaceId).update({ repoFullNames: ['owner/repo', 'owner/finding'] });
  await db.collection('github_installations').doc(f.workspaceId).update({ repositoryFullNames: ['owner/repo', 'owner/finding'] });
  await db.collection('agents').doc(f.agentId).update({ allowedRepos: ['owner/repo', 'owner/finding'] });
  await db.collection('runners').doc(f.runnerId).update({ connectedRepos: ['owner/repo', 'owner/finding'],
    'readiness.repositories': [{ repo: 'owner/repo', accessible: true }, { repo: 'owner/finding', accessible: true }],
    'readiness.providers.codex.session': false });
  const original = runnerJobSigningPrivateKey.value;
  runnerJobSigningPrivateKey.value = () => privateKey;
  try {
    await transition(f.issueId, { 'review.state': 'changes_requested',
      'review.findings': [{ status: 'open', severity: 'major', repoFullName: 'owner/finding' }] });
    let issue = (await ref.get()).data()!;
    assert.equal(issue.agent.dispatchFailure.stage, 'preflight');
    assert.equal(issue.review.reworkDispatchedForAttempt, undefined);
    assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
    await db.collection('runners').doc(f.runnerId).update({ 'readiness.providers.codex.session': true });
    await transition(f.issueId, { status: 'backlog' });
    const retryEvent = await transition(f.issueId, { status: 'todo' });
    assert.equal(retryEvent.data.before.data()!.review.state, 'changes_requested');
    assert.equal(retryEvent.data.after.data()!.review.state, 'changes_requested');
    await Promise.all([agentDispatchTrigger.run(retryEvent as any), agentDispatchTrigger.run(retryEvent as any)]);
    assert.deepEqual(await counts(f), { jobs: 2, runs: 2, budget: 2 });
    const jobs = (await db.collection('runner_jobs').where('issueId', '==', f.issueId).get()).docs;
    const rework = jobs.find((job) => job.id !== task.id)!;
    assert.equal(rework.data().mode, 'rework');
    assert.equal(rework.data().repoFullName, 'owner/finding');
    const run = (await db.collection('agent_runs').doc(rework.id).get()).data()!;
    assert.equal(run.mode, 'rework');
    assert.equal(run.reviewAttempt, 1);
    issue = (await ref.get()).data()!;
    assert.equal(issue.agent.dispatchFailure, undefined);
    assert.equal(issue.review.attempt, 1);
    assert.equal(issue.review.reworkDispatchedForAttempt, 1);
    // After completion AND cooldown expiry, status toggles still cannot emit
    // either another rework or a task for an already reserved QA attempt.
    await db.collection('runner_jobs').doc(rework.id).update({ status: 'completed' });
    await ref.update({ 'agent.dispatchedAt': '2000-01-01T00:00:00.000Z' });
    await transition(f.issueId, { status: 'backlog' });
    await transition(f.issueId, { status: 'todo' });
    assert.deepEqual(await counts(f), { jobs: 2, runs: 2, budget: 2 });
  } finally { runnerJobSigningPrivateKey.value = original; }
});

test('retrying a shadow QA rejection cannot fall through to task dispatch', async () => {
  const f = await taskFixture();
  const reviewerId = `qa-${f.agentId}`;
  await db.collection('agents').doc(f.agentId).update({ autonomousMode: true });
  await db.collection('agents').doc(reviewerId).set({ qaMode: 'shadow' });
  await db.collection('issues').doc(f.issueId).update({ status: 'in_progress', review: { state: 'changes_requested', attempt: 1, reviewerId } });
  await transition(f.issueId, { status: 'backlog' });
  await transition(f.issueId, { status: 'todo' });
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
});

for (const mode of ['handoff', 'rework'] as const) {
  async function continuationFixture() {
    const f = await taskFixture();
    const requestedAt = new Date().toISOString();
    const reservation = mode === 'handoff' ? { mode, requestedAt } : { mode, attempt: 1 };
    await db.collection('agents').doc(f.agentId).update({ autonomousMode: true });
    await db.collection('issues').doc(f.issueId).update({
      status: 'in_progress', responsibleMemberId: f.owner, git: { repoFullName: 'owner/repo', ...(mode === 'rework' ? { branch: 'pul/int-rework', prNumber: 1, prState: 'open' } : {}) },
      // A previous successful task cooldown must not hide continuation errors.
      agent: { state: 'idle', dispatchedAt: new Date(Date.now() - 1000).toISOString(), dispatchedTo: f.agentId },
      ...(mode === 'handoff' ? { pendingRepoWork: [{ repoFullName: 'owner/repo', requestedAt }] }
        : { review: { state: 'changes_requested', attempt: 1 } }),
    });
    const dispatch = async () => {
      await transition(f.issueId, { status: 'backlog' });
      await transition(f.issueId, { status: 'todo' });
    };
    const emit = (key = privateKey, database = db) => enqueueRunnerJob(database, { ...f.input, mode }, key, 'runner-job-v1', reservation);
    return { ...f, reservation, dispatch, emit };
  }

  test(`${mode} trigger reports preflight/signing failures and retries without reservation or spend`, async () => {
    const f = await continuationFixture();
    const original = runnerJobSigningPrivateKey.value;
    runnerJobSigningPrivateKey.value = () => privateKey;
    try {
      await db.collection('runners').doc(f.runnerId).update({ 'readiness.providers.codex.session': false });
      await f.dispatch();
      let issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
      assert.equal(issue.agent.dispatchFailure.stage, 'preflight');
      assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
      const diagnosticTime = issue.agent.dispatchFailure.at;
      await f.dispatch();
      assert.equal((await db.collection('issues').doc(f.issueId).get()).data()!.agent.dispatchFailure.at, diagnosticTime);
      await db.collection('runners').doc(f.runnerId).update({ 'readiness.providers.codex.session': true });
      runnerJobSigningPrivateKey.value = () => 'invalid signing material';
      await f.dispatch();
      issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
      assert.equal(issue.agent.dispatchFailure.stage, 'enqueue');
      assert.doesNotMatch(JSON.stringify(issue.agent.dispatchFailure), /invalid signing material/);
      assert.equal(mode === 'handoff' ? issue.pendingRepoWork[0].dispatchedAt : issue.review.reworkDispatchedForAttempt, undefined);
      assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
      runnerJobSigningPrivateKey.value = () => privateKey;
      await db.collection('runners').doc(f.runnerId).update({ maxConcurrentJobs: 10 });
      await Promise.all([f.dispatch(), f.dispatch(), f.dispatch()]);
      assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
      issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
      assert.equal(issue.agent.dispatchFailure, undefined);
      assert.ok(mode === 'handoff' ? issue.pendingRepoWork[0].dispatchedAt : issue.review.reworkDispatchedForAttempt === 1);
      // A delayed failure cannot replace a successfully issued continuation.
      await reportDispatchFailure(db, f.issueId, f.agentId, new Date().toISOString(), new Error('unsafe transport'),
        f.reservation.mode === 'handoff' ? { ...f.reservation, repoFullName: 'owner/repo' } : f.reservation);
      assert.equal((await db.collection('issues').doc(f.issueId).get()).data()!.agent.dispatchFailure, undefined);
    } finally { runnerJobSigningPrivateKey.value = original; }
  });

  test(`${mode} capacity failure and stale continuation do not reserve or spend`, async () => {
    const f = await continuationFixture();
    const busy = db.collection('runner_jobs').doc(`busy-${f.agentId}`);
    await busy.set({ runnerId: f.runnerId, issueId: 'another-issue', status: 'delivered', expiresAt: new Date(Date.now() + 60000).toISOString() });
    await assert.rejects(f.emit(), (error: any) => error.stage === 'enqueue' && /capacidad/.test(error.message));
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
    await busy.update({ status: 'completed' });
    const ref = db.collection('issues').doc(f.issueId);
    await ref.update(mode === 'handoff'
      ? { pendingRepoWork: [{ repoFullName: 'owner/repo', requestedAt: 'replacement-request' }] }
      : { 'review.attempt': 2 });
    await assert.rejects(f.emit(), (error: any) => error.silent === true);
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
  });

  test(`${mode} enqueue commit failure rolls back budget, marker and run`, async () => {
    const f = await continuationFixture();
    const failingDb = {
      collection: db.collection.bind(db),
      runTransaction: (work: any) => db.runTransaction((tx) => work(new Proxy(tx, {
        get(target, key) {
          if (key === 'create') return (ref: any, value: any) => {
            if (ref.parent.id === 'runner_jobs') throw new Error('Injected enqueue failure');
            return target.create(ref, value);
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }))),
    } as any;
    await assert.rejects(f.emit(privateKey, failingDb), /Injected enqueue failure/);
    let issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
    assert.equal(mode === 'handoff' ? issue.pendingRepoWork[0].dispatchedAt : issue.review.reworkDispatchedForAttempt, undefined);
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
    await db.collection('workspaces').doc(f.workspaceId).set({ agentsPaused: true });
    await assert.rejects(f.emit(), (error: any) => error.stage === 'budget');
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, budget: 0 });
    await db.collection('workspaces').doc(f.workspaceId).update({ agentsPaused: false });
    await f.emit();
    assert.deepEqual(await counts(f), { jobs: 1, runs: 1, budget: 1 });
  });
}
