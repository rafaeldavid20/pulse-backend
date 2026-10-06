import { strict as assert } from 'node:assert';
import { test } from 'node:test';

// Exercise the real trigger with in-memory Firestore and dispatch boundaries.
// No emulator, network, Runner signatures or production credentials are used.
const Module = require('node:module');
const originalLoad = Module._load;
let issue: Record<string, any>;
let agents: Record<string, any>[];
let dispatches: string[];
let runners: Record<string, any> = {};
const deleted = Symbol('delete');
const snapshot = (data: any, id = 'issue') => ({ id, exists: !!data, data: () => data });
const update = (patch: Record<string, any>) => {
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split('.');
    let target = issue;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    if (value === deleted) delete target[parts.at(-1)!];
    else target[parts.at(-1)!] = value;
  }
};
const issueRef = { get: async () => snapshot(issue), update: async (patch: any) => update(patch) };
const db = {
  collection: (name: string) => {
    const filters: Array<[string, any]> = [];
    const query: any = {
      where: (field: string, _op: string, value: any) => { filters.push([field, value]); return query; },
      limit: () => query,
      get: async () => {
        const rows = name === 'agents'
          ? agents.filter((agent) => filters.every(([field, value]) => agent[field] === value))
          : name === 'github_installations' ? [{ installationId: 1 }] : [];
        return { empty: rows.length === 0, docs: rows.map((row) => snapshot(row, row.id)) };
      },
      doc: (id: string) => name === 'issues' ? issueRef : name === 'agents'
        ? { get: async () => snapshot(agents.find((agent) => agent.id === id), id) }
        : name === 'runners' ? { get: async () => snapshot(runners[id], id) }
        : { get: async () => snapshot(undefined, id), set: async () => {} },
    };
    return query;
  },
  runTransaction: async (fn: any) => fn({ get: async () => snapshot(issue), update: (_ref: any, patch: any) => update(patch) }),
};
Module._load = function (name: string, ...args: any[]) {
  if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { delete: () => deleted } };
  if (name.endsWith('/github/client')) return {
    getPullRequestOrigin: async () => ({ headRepoFullName: 'owner/repo', headRef: 'pul/test', headSha: 'new' }),
    dispatchRepositoryEvent: async (_install: any, _repo: any, _event: any, payload: any) => { dispatches.push(payload.agentId); },
  };
  if (name.endsWith('/common/utils/runner-jobs')) return { enqueueRunnerJob: async (_db: any, input: any) => { dispatches.push(input.agentId); return { ...input, id: 'job-test' }; } };
  if (name.endsWith('/common/utils/repo-resolution')) return { resolveIssueRepo: async () => ({ repoFullName: 'owner/repo' }) };
  if (name.endsWith('/common/utils/dispatch-counter')) return { checkWorkspaceDispatchBudget: async () => ({ allowed: true }), todayKey: () => '2026-10-01' };
  if (name.endsWith('/common/utils/issue-run-budget')) return { checkIssueRunBudget: async () => ({ withinBudget: true }) };
  if (name === '../../common/platform-actions/handler') return {
    PlatformActionHandler: class { action: any; constructor(_code: string, request: any) { this.action = request; } },
  };
  return originalLoad.call(this, name, ...args);
};
const { qaDispatchTrigger } = require('../../triggers/qa-dispatch');
const { ReviewsRerunAction } = require('../../actions/reviews/rerun-review');
Module._load = originalLoad;

const qa = (id: string, extra = {}) => ({ id, workspaceId: 'ws', role: 'qa', enabled: true, autonomousMode: true, reviewRepo: 'owner/repo', ...extra });
function reset() {
  issue = { workspaceId: 'ws', identifier: 'TES-303', status: 'in_review', assigneeId: 'human', execution: { agentId: 'dev' },
    git: { repoFullName: 'owner/repo', prNumber: 1, prState: 'open', branch: 'pul/test' } };
  dispatches = []; runners = {};
}
const run = () => qaDispatchTrigger.run({ params: { issueId: 'issue' }, data: { before: snapshot({ status: 'in_progress' }), after: snapshot(structuredClone(issue)) } });

test('automatic QA is reselected on the next review if previous QA is unavailable', async () => {
  reset(); agents = [qa('first'), qa('second')];
  await run();
  assert.equal(issue.review.dispatchedTo, 'first');
  assert.equal(issue.qaAssigneeId, undefined);
  agents[0].enabled = false;
  await run();
  assert.deepEqual(dispatches, ['first', 'second']);
  assert.equal(issue.review.dispatchedTo, 'second');
  assert.equal(issue.qaAssigneeId, undefined);
  assert.equal(issue.assigneeId, 'human');
  assert.deepEqual(issue.execution, { agentId: 'dev' });
});
test('manual non-autonomous QA wins over automatic candidates', async () => {
  reset(); agents = [qa('auto'), qa('manual', { autonomousMode: false })]; issue.qaAssigneeId = 'manual';
  await run();
  assert.deepEqual(dispatches, ['manual']);
  assert.equal(issue.qaAssigneeId, 'manual');
  assert.equal(issue.assigneeId, 'human');
});
test('invalid manual QA leaves visible error without dispatch or development reassignment', async () => {
  reset(); agents = [qa('manual', { enabled: false }), qa('auto')]; issue.qaAssigneeId = 'manual';
  await run();
  assert.equal(dispatches.length, 0);
  assert.match(issue.review.dispatchError, /habilitado/);
  assert.equal(issue.status, 'in_review');
  assert.equal(issue.assigneeId, 'human');
});
test('no autonomous QA stays unassigned and a later dispatch clears the error', async () => {
  reset(); agents = [];
  await run();
  assert.equal(issue.qaAssigneeId, undefined);
  assert.equal(issue.status, 'in_review');
  assert.ok(issue.review.dispatchError);
  agents = [qa('available')];
  await run();
  assert.deepEqual(dispatches, ['available']);
  assert.equal(issue.review.dispatchError, undefined);
});

test('explicit rerun also keeps automatic QA separate from manual selection', async () => {
  reset(); agents = [qa('first'), qa('second')];
  await new ReviewsRerunAction({ data: { issueId: 'issue' } }).handleAction();
  assert.equal(issue.qaAssigneeId, undefined);
  agents[0].enabled = false;
  await new ReviewsRerunAction({ data: { issueId: 'issue' } }).handleAction();
  assert.deepEqual(dispatches, ['first', 'second']);
  assert.equal(issue.review.dispatchedTo, 'second');
  assert.equal(issue.assigneeId, 'human');
});
test('automatic selection falls back when the first QA Runner is unavailable', async () => {
  reset(); agents = [qa('offline', { runnerId: 'offline-runner' }), qa('fallback')];
  await run();
  assert.deepEqual(dispatches, ['fallback']);
  assert.equal(issue.qaAssigneeId, undefined);
});

test('automatic QA skips a Runner with an incompatible local identity and selects a prepared Runner', async () => {
  reset(); agents = [qa('first', { runnerId: 'runner-first', kind: 'codex' }), qa('second', { runnerId: 'runner-second', kind: 'codex' })];
  for (const id of ['first', 'second']) runners[`runner-${id}`] = { id: `runner-${id}`, workspaceId: 'ws', status: 'online', lastHeartbeatAt: new Date().toISOString(), readinessCheckedAt: new Date().toISOString(), connectedRepos: ['owner/repo'], readiness: { jobProtocolVersion: 2, workspaceId: 'ws', identities: [{ agentId: id, kind: 'codex', role: id === 'first' ? 'dev' : 'qa' }], providers: { codex: { cli: true, session: true } }, repositories: [{ repo: 'owner/repo', accessible: true }] } };
  await run();
  assert.deepEqual(dispatches, ['second']);
  assert.equal(issue.review.dispatchedTo, 'second');
  assert.equal(issue.review.dispatchError, undefined);
});
