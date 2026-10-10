import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { RequestReworkAction } from '../actions/reviews/request-rework';
import { runnerJobSigningPrivateKey } from '../common/secrets';
import { todayKey } from '../common/utils/dispatch-counter';
import { agentDispatchTrigger } from '../triggers/agent-dispatch';
import { buildMcpTransport } from '../mcp/server';
import { McpPrincipal } from '../mcp/auth';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { reworkRepositories } from '../common/utils/human-rework';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
runnerJobSigningPrivateKey.value = () => privateKey;

async function fixture() {
  const suffix = randomBytes(8).toString('hex');
  const workspaceId = `ws-human-${suffix}`, projectId = `project-${suffix}`, issueId = `issue-${suffix}`;
  const agentId = `dev-${suffix}`, qaId = `qa-${suffix}`, runnerId = `runner-${suffix}`;
  const owner = `human-${suffix}`, other = `other-${suffix}`, admin = `admin-${suffix}`;
  const refs = [{ repoFullName: 'owner/backend', branch: `pul/int-${suffix}`, prNumber: 1, prState: 'open', headSha: 'a'.repeat(40) }];
  const now = new Date().toISOString();
  const issue = { id: issueId, identifier: `INT-${parseInt(suffix.slice(0, 8), 16)}`, workspaceId, projectId, status: 'in_review',
    assigneeId: owner, responsibleMemberId: owner, execution: { agentId, mode: 'personal', assignedBy: owner },
    agent: { state: 'idle' }, git: refs[0], gitRefs: refs,
    review: { state: 'changes_requested', attempt: 1, reviewerId: qaId,
      findings: [{ id: 'finding-1', severity: 'major', status: 'open', repoFullName: 'owner/backend', message: 'Fix regression' }], history: [] } };
  await Promise.all([
    db.collection('workspaces').doc(workspaceId).set({ dailyDispatchLimit: 20, maxRunsPerIssue: 6 }),
    ...[[owner, 'member'], [other, 'member'], [admin, 'admin'], [agentId, 'member'], [qaId, 'member']].map(([uid, role]) => db.collection('members').doc(`${workspaceId}_${uid}`).set({ workspaceId, userId: uid, role, isAgent: [agentId, qaId].includes(uid) })),
    db.collection('issues').doc(issueId).set(issue),
    db.collection('projects').doc(projectId).set({ workspaceId, repoFullNames: ['owner/backend', 'owner/app'] }),
    db.collection('github_installations').doc(workspaceId).set({ workspaceId, repositoryFullNames: ['owner/backend', 'owner/app'] }),
    db.collection('agents').doc(agentId).set({ id: agentId, workspaceId, role: 'dev', kind: 'codex', ownerMemberId: owner, visibility: 'personal', enabled: true, autonomousMode: true, runnerId }),
    db.collection('agents').doc(qaId).set({ id: qaId, workspaceId, role: 'qa', kind: 'codex', enabled: true, qaMode: 'shadow', maxReviewAttempts: 2 }),
    db.collection('runners').doc(runnerId).set({ id: runnerId, workspaceId, ownerMemberId: owner, status: 'online', maxConcurrentJobs: 10,
      lastHeartbeatAt: now, readinessCheckedAt: now, readiness: { workspaceId, jobProtocolVersion: 3,
        identities: [{ agentId, kind: 'codex', role: 'dev' }], providers: { codex: { cli: true, session: true } },
        githubApps: ['owner/backend', 'owner/app'].map(repo => ({ repo, projectId, appId: '1', installationId: '2', slug: 'test-app', base: 'main', ready: true })) } }),
  ]);
  return { ...issue, issueId, agentId, qaId, runnerId, owner, other, admin };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (f: Fixture, caller = f.owner, comment = 'Corregí los findings de QA y actualizá el mismo PR.') =>
  new RequestReworkAction({ actionCode: 'reviews.requestRework', data: { issueId: f.issueId, comment } }, caller).run();
async function counts(f: Fixture) {
  return { jobs: (await db.collection('runner_jobs').where('issueId', '==', f.issueId).get()).size,
    runs: (await db.collection('agent_runs').where('issueId', '==', f.issueId).get()).size,
    comments: (await db.collection('comments').where('issueId', '==', f.issueId).get()).size,
    budget: (await db.collection('agent_dispatch_counters').doc(`${f.workspaceId}_${todayKey()}`).get()).data()?.count || 0 };
}
async function trigger(f: Fixture) {
  const after = (await db.collection('issues').doc(f.issueId).get()).data()!;
  await agentDispatchTrigger.run({ params: { issueId: f.issueId }, data: {
    before: { data: () => ({ ...after, review: { ...after.review, state: 'pending' } }) }, after: { data: () => after },
  } } as any);
}

test('human request after shadow rejection signs the existing PR branch and preserves ownership, QA and findings', async () => {
  const f = await fixture();
  await trigger(f);
  assert.deepEqual(await counts(f), { jobs: 0, runs: 0, comments: 0, budget: 0 }, 'shadow QA must not dispatch automatically');
  const result = await request(f); assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(await counts(f), { jobs: 1, runs: 1, comments: 1, budget: 1 });
  const issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
  assert.equal(issue.status, 'in_progress'); assert.equal(issue.assigneeId, f.owner); assert.equal(issue.responsibleMemberId, f.owner);
  assert.deepEqual(issue.execution, f.execution); assert.deepEqual(issue.gitRefs, f.gitRefs);
  assert.deepEqual(issue.review.findings, f.review.findings); assert.deepEqual(issue.review.history, []);
  assert.equal(issue.review.attempt, 1); assert.equal(issue.review.reworkDispatchedForAttempt, 1); assert.equal(issue.runBudgetResetAt, undefined);
  assert.equal((await db.collection('agents').doc(f.qaId).get()).data()!.qaMode, 'shadow');
  const job = (await db.collection('runner_jobs').doc(result.data!.jobId).get()).data()!;
  assert.equal(job.mode, 'rework'); assert.deepEqual(job.contextRepos, ['owner/backend'], 'unrelated project repos have no PR branch to correct');
  assert.equal(job.publicationTargets[0].branch, f.git.branch); assert.equal(job.publicationTargets[0].repo, f.git.repoFullName);
  assert.equal((await db.collection('agent_runs').doc(job.id).get()).data()!.requestedBy, f.owner);
});

test('concurrent human requests and automatic enforce dispatch reserve exactly one correction', async () => {
  const f = await fixture();
  await db.collection('agents').doc(f.qaId).update({ qaMode: 'enforce' });
  await Promise.all([request(f), request(f), trigger(f)]);
  assert.equal((await counts(f)).jobs, 1); assert.equal((await counts(f)).runs, 1); assert.equal((await counts(f)).budget, 1);
  const comments = (await counts(f)).comments; assert.ok(comments <= 1);
  assert.equal((await db.collection('agents').doc(f.qaId).get()).data()!.qaMode, 'enforce');
});

test('automatic enforce rework continues to use the existing PR rather than inventing unrelated branches', async () => {
  const f = await fixture(); await db.collection('agents').doc(f.qaId).update({ qaMode: 'enforce' });
  await trigger(f); assert.deepEqual(await counts(f), { jobs: 1, runs: 1, comments: 0, budget: 1 });
  const job = (await db.collection('runner_jobs').where('issueId', '==', f.issueId).get()).docs[0].data();
  assert.deepEqual(job.contextRepos, ['owner/backend']); assert.equal(job.publicationTargets[0].branch, f.git.branch);
});

for (const caller of ['other', 'agentId', 'qaId'] as const) test(`human action rejects ${caller} without dispatching or changing the issue`, async () => {
  const f = await fixture(); const before = (await db.collection('issues').doc(f.issueId).get()).data();
  assert.equal((await request(f, f[caller])).success, false); assert.deepEqual(await counts(f), { jobs: 0, runs: 0, comments: 0, budget: 0 });
  assert.deepEqual((await db.collection('issues').doc(f.issueId).get()).data(), before);
});

test('public dev requires a human admin, while member-created personal access has no authority over other owners', async () => {
  const f = await fixture(); await db.collection('agents').doc(f.agentId).update({ visibility: 'public' });
  assert.equal((await request(f, f.owner)).success, false); assert.equal((await request(f, f.admin)).success, true);
});

test('enqueue revalidates closed, merged and newly added PRs after the initial human request snapshot', async () => {
  for (const change of ['closed', 'merged', 'new-pr']) {
    const f = await fixture();
    const contextRepos = reworkRepositories(f, ['owner/backend', 'owner/app'], 'owner/backend');
    const gitRefs = change === 'new-pr'
      ? [...f.gitRefs, { repoFullName: 'owner/app', branch: 'pul/new-app-pr', prNumber: 2, prState: 'open' }]
      : [{ ...f.gitRefs[0], prState: change }];
    await db.collection('issues').doc(f.issueId).update({ gitRefs, status: 'in_progress' });
    await assert.rejects(enqueueRunnerJob(db, {
      workspaceId: f.workspaceId, projectId: f.projectId, issueId: f.issueId, agentId: f.agentId,
      runnerId: f.runnerId, repoFullName: 'owner/backend', contextRepos, mode: 'rework',
    }, privateKey, 'runner-job-v1', { mode: 'rework', attempt: 1, requestedBy: f.owner, comment: 'Corregir QA' }));
    assert.deepEqual(await counts(f), { jobs: 0, runs: 0, comments: 0, budget: 0 });
  }
});

for (const [name, collection, patch] of [
  ['revoked Runner', 'runners', { revokedAt: new Date().toISOString() }],
  ['stale preparation', 'runners', { readinessCheckedAt: '2000-01-01T00:00:00Z' }],
  ['archived agent', 'agents', { archivedAt: new Date().toISOString() }],
  ['foreign agent', 'agents', { workspaceId: 'foreign' }],
  ['paused workspace', 'workspaces', { agentsPaused: true }],
  ['daily dispatch limit', 'workspaces', { dailyDispatchLimit: 0 }],
  ['issue run limit', 'workspaces', { maxRunsPerIssue: 0 }],
] as const) test(`human request respects ${name} and consumes nothing on failure`, async () => {
  const f = await fixture(); const id = collection === 'runners' ? f.runnerId : collection === 'agents' ? f.agentId : f.workspaceId;
  await db.collection(collection).doc(id).update(patch);
  assert.equal((await request(f)).success, false); assert.deepEqual(await counts(f), { jobs: 0, runs: 0, comments: 0, budget: 0 });
});

test('review limits, terminal issue and missing/closed PR never emit a new task or reset budgets', async () => {
  for (const patch of [{ 'review.attempt': 2 }, { status: 'done' }, { 'review.state': 'needs_human' }, { gitRefs: [{ repoFullName: 'owner/backend', prNumber: 1, prState: 'closed', branch: 'pul/closed' }] }]) {
    const f = await fixture(); await db.collection('issues').doc(f.issueId).update(patch);
    assert.equal((await request(f)).success, false); assert.equal((await counts(f)).jobs, 0);
    assert.equal((await db.collection('issues').doc(f.issueId).get()).data()!.runBudgetResetAt, undefined);
  }
});

async function mcp(f: Fixture, overrides: Partial<McpPrincipal> = {}) {
  const transport = await buildMcpTransport({ workspaceId: f.workspaceId, agentId: null, createdBy: f.owner, scopes: ['issues:write'], source: 'api_key', ...overrides });
  try {
    const response = await transport.handleRequest(new Request('http://localhost/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pulse_request_rework', arguments: { identifier: f.identifier, comment: 'Corregir los findings de QA.' } } }) }));
    const body: any = await response.json();
    return JSON.parse(body.result.content[0].text);
  } finally { await transport.close(); }
}
test('MCP personal access can request rework; missing scope and agent credentials are denied', async () => {
  const f = await fixture();
  assert.match((await mcp(f, { scopes: ['issues:read'] })).error, /scope/);
  assert.match((await mcp(f, { agentId: f.agentId })).error, /personal/);
  assert.match((await mcp(f, { agentId: f.qaId, scopes: ['reviews:write'] })).error, /scope/);
  assert.match((await mcp(f, { workspaceId: 'foreign' })).error, /No issue/);
  assert.equal((await counts(f)).jobs, 0);
  const result = await mcp(f); assert.ok(result.jobId, JSON.stringify(result)); assert.equal(result.mode, 'rework'); assert.equal((await counts(f)).jobs, 1);
});
