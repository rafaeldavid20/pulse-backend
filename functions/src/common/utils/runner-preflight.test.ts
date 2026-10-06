import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunnerReadiness, runnerPreflight } from './runner-preflight';
const now = Date.now();
const agent = { id: 'agent-1', workspaceId: 'ws-1', enabled: true, kind: 'codex', role: 'dev', runnerId: 'runner-1', visibility: 'personal', ownerMemberId: 'owner', allowedRepos: ['owner/app'] };
const readiness = { workspaceId: 'ws-1', identities: [{ agentId: 'agent-1', kind: 'codex', role: 'dev' }], providers: { codex: { cli: true, session: true }, claude: { cli: false, session: false } }, repositories: [{ repo: 'owner/app', accessible: true }] };
const runner = { id: 'runner-1', workspaceId: 'ws-1', ownerMemberId: 'owner', status: 'online', lastHeartbeatAt: new Date(now).toISOString(), readinessCheckedAt: new Date(now).toISOString(), connectedRepos: ['owner/app'], readiness };
const check = (a: any = agent, r: any = runner, mode = 'task') => runnerPreflight(a, r, 'ws-1', ['owner/app'], mode, now);

test('compatible dev and explicitly configured QA identities pass', () => {
  assert.equal(check().ready, true);
  const qa = { ...agent, role: 'qa' };
  assert.equal(check(qa, { ...runner, readiness: { ...readiness, identities: [{ ...readiness.identities[0], role: 'qa' }] } }, 'review').ready, true);
  assert.equal(check(qa, runner, 'task').ready, false);
});
test('wrong workspace, owner, identity, provider or revoked/stale Runner block dispatch', () => {
  for (const changed of [{ workspaceId: 'other' }, { ownerMemberId: 'other' }, { revokedAt: 'now' }, { status: 'busy' }, { lastHeartbeatAt: new Date(now - 121000).toISOString() }, { readinessCheckedAt: new Date(now - 121000).toISOString() }, { readiness: { ...readiness, identities: [{ agentId: 'other', kind: 'codex', role: 'dev' }] } }, { readiness: { ...readiness, identities: [{ agentId: 'agent-1', kind: 'claude', role: 'dev' }] } }]) {
    const result = check(agent, { ...runner, ...changed });
    assert.equal(result.ready, false);
    assert.ok(result.problems.every((problem) => problem.action.length > 0));
  }
  assert.equal(check({ ...agent, workspaceId: 'other' }).ready, false);
  assert.equal(check({ ...agent, runnerId: 'runner-2' }).ready, false);
});
test('missing local sessions and repository access block dispatch', () => {
  const result = check(agent, { ...runner, readiness: { ...readiness, providers: { codex: { cli: true, session: false } }, repositories: [] } });
  assert.deepEqual(result.problems.map((problem) => problem.code), ['session', 'repository_access']);
  assert.equal(check({ ...agent, allowedRepos: ['owner/other'] }).ready, false);
});
test('report parser strips output, account and credential fields, rejects malformed reports', () => {
  const report = parseRunnerReadiness({ ...readiness, token: 'never-store', providers: { ...readiness.providers, codex: { cli: true, session: true, output: 'never-store' } } });
  assert.equal(JSON.stringify(report).includes('never-store'), false);
  assert.throws(() => parseRunnerReadiness({ ...readiness, providers: {} }));
  assert.throws(() => parseRunnerReadiness({ ...readiness, repositories: [{ repo: 'https://token@host/repo', accessible: true }] }));
});

test('project-scoped preflight gates old Runners and does not require duplicate allowlists', () => {
  const old = runnerPreflight(agent, runner, 'ws-1', [], 'task', now, true);
  assert.equal(old.ready, false);
  assert.match(old.problems.find((p) => p.code === 'runner_upgrade')!.action, /npm install/);
  const upgraded = { ...runner, connectedRepos: [], readiness: { ...readiness, repositories: [], jobProtocolVersion: 2 } };
  assert.equal(runnerPreflight({ ...agent, allowedRepos: [] }, upgraded, 'ws-1', ['owner/private'], 'task', now, true).ready, true);
  assert.equal(parseRunnerReadiness(upgraded.readiness).jobProtocolVersion, 2);
  assert.throws(() => parseRunnerReadiness({ ...readiness, jobProtocolVersion: 99 }));
});

test('QA requires snapshot support while project authorization remains independent of global Git access', () => {
  const qa = { ...agent, role: 'qa' };
  const prepared = { ...runner, readiness: { ...readiness, jobProtocolVersion: 2, repositories: [], identities: [{ agentId: qa.id, kind: qa.kind, role: 'qa' }] } };
  assert(runnerPreflight(qa, prepared, 'ws-1', ['owner/private-runner'], 'review', now, true).problems.some((problem) => problem.code === 'qa_source_upgrade'));
  assert(runnerPreflight(qa, { ...prepared, readiness: { ...prepared.readiness, qaSourceProtocolVersion: 1 } }, 'ws-1', ['owner/private-runner'], 'review', now, true).ready);
  assert.equal(parseRunnerReadiness({ ...readiness, qaSourceProtocolVersion: 1 }).qaSourceProtocolVersion, 1);
});
