import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findProjectQaRunner } from './qa-runner';

const now = Date.now();
const readyRunner = (id: string, ownerMemberId: string, identities: Array<{ agentId: string; kind: 'codex'; role: 'qa' | 'dev' }>, extra = {}) => ({
  id, ownerMemberId, workspaceId: 'ws', status: 'online', lastHeartbeatAt: new Date(now).toISOString(), readinessCheckedAt: new Date(now).toISOString(),
  maxConcurrentJobs: 1, connectedRepos: [],
  readiness: { workspaceId: 'ws', identities, providers: { codex: { cli: true, session: true }, claude: { cli: false, session: false } }, repositories: [], jobProtocolVersion: 2, qaSourceProtocolVersion: 1 },
  ...extra,
});
function database(runners: any[], jobs: any[] = []) {
  return { collection: (name: string) => {
    const filters: Array<[string, any]> = [];
    const query: any = {
      where: (field: string, _op: string, value: any) => { filters.push([field, value]); return query; },
      get: async () => {
        const rows = (name === 'runners' ? runners : jobs).filter((row) => filters.every(([key, value]) => row[key] === value));
        return { docs: rows.map((row) => ({ id: row.id, data: () => row })) };
      },
    };
    return query;
  } } as any;
}
const qaAgent = { id: 'qa-codex', runnerId: 'runner-old', ownerMemberId: 'owner', workspaceId: 'ws', enabled: true, role: 'qa', kind: 'codex', visibility: 'public' };

test('a QA identity can reuse another online Runner owned by the same member', async () => {
  const offlineBound = { id: 'runner-old', ownerMemberId: 'owner', workspaceId: 'ws', status: 'offline', lastHeartbeatAt: new Date(now - 60_000).toISOString(), readinessCheckedAt: new Date(now - 60_000).toISOString() };
  const shared = readyRunner('runner-dev', 'owner', [{ agentId: 'qa-codex', kind: 'codex', role: 'qa' }]);

  const result = await findProjectQaRunner(database([offlineBound, shared]), qaAgent, 'ws', ['owner/app', 'owner/backend'], now);

  assert.equal(result.runner?.id, 'runner-dev');
  assert.deepEqual(result.problems, []);
});

test('a matching identity on another member Runner is not borrowed', async () => {
  const foreign = readyRunner('runner-foreign', 'someone-else', [{ agentId: 'qa-codex', kind: 'codex', role: 'qa' }]);

  const result = await findProjectQaRunner(database([foreign]), qaAgent, 'ws', ['owner/app'], now);

  assert.equal(result.runner, undefined);
});

test('a bound Runner without the QA identity returns actionable preflight failures', async () => {
  const runner = readyRunner('runner-old', 'owner', [{ agentId: 'codex-runner', kind: 'codex', role: 'dev' }]);

  const result = await findProjectQaRunner(database([runner]), qaAgent, 'ws', ['owner/app'], now);

  assert.equal(result.runner, undefined);
  assert.match(result.problems.join(' '), /identidad local/);
});

test('prepared busy QA reports capacity separately from unrelated shared Runner login advice', async () => {
  const bound = readyRunner('runner-old', 'owner', [{ agentId: 'qa-codex', kind: 'codex', role: 'qa' }]);
  const unrelated = { id: 'unrelated', workspaceId: 'ws', ownerMemberId: 'owner', status: 'offline' };
  const result = await findProjectQaRunner(database([bound, unrelated], [{ runnerId: 'runner-old', status: 'delivered', expiresAt: new Date(now + 60_000).toISOString() }]), qaAgent, 'ws', ['owner/repo'], now);
  assert.equal(result.runner, undefined);
  assert.deepEqual(result.busyRunnerIds, ['runner-old']);
  assert.deepEqual(result.problems, []);
});
test('same-owner Runner lacking this QA identity contributes no setup or login advice', async () => {
  const unrelated = { id: 'unrelated', workspaceId: 'ws', ownerMemberId: 'owner', status: 'offline' };
  const result = await findProjectQaRunner(database([unrelated]), qaAgent, 'ws', ['owner/repo'], now);
  assert.equal(result.runner, undefined);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.busyRunnerIds, []);
});

for (const outage of ['offline', 'heartbeat', 'readiness']) {
  test(`prepared QA with temporary ${outage} failure remains retryable`, async () => {
    const runner = readyRunner('runner-old', 'owner', [{ agentId: 'qa-codex', kind: 'codex', role: 'qa' }],
      outage === 'offline' ? { status: 'offline' } : outage === 'heartbeat'
        ? { lastHeartbeatAt: new Date(now - 180_000).toISOString() }
        : { readinessCheckedAt: new Date(now - 180_000).toISOString() });
    const result = await findProjectQaRunner(database([runner]), qaAgent, 'ws', ['owner/repo'], now);
    assert.equal(result.runner, undefined);
    assert.deepEqual(result.unavailableRunnerIds, ['runner-old']);
    assert.deepEqual(result.problems, []);
  });
}
test('revocation and invalid session remain permanent even when readiness is stale', async () => {
  for (const failure of ['revoked', 'session']) {
    const runner = readyRunner('runner-old', 'owner', [{ agentId: 'qa-codex', kind: 'codex', role: 'qa' }],
      { readinessCheckedAt: new Date(now - 180_000).toISOString() });
    if (failure === 'revoked') Object.assign(runner, { revokedAt: new Date(now).toISOString() });
    else runner.readiness.providers.codex.session = false;
    const result = await findProjectQaRunner(database([runner]), qaAgent, 'ws', ['owner/repo'], now);
    assert.deepEqual(result.unavailableRunnerIds, []);
    assert.ok(result.problems.length);
  }
});
