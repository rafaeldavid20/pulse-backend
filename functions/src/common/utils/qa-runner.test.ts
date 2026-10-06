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

test('a same-owner Runner without the QA identity returns actionable preflight failures', async () => {
  const runner = readyRunner('runner-dev', 'owner', [{ agentId: 'codex-runner', kind: 'codex', role: 'dev' }]);

  const result = await findProjectQaRunner(database([runner]), qaAgent, 'ws', ['owner/app'], now);

  assert.equal(result.runner, undefined);
  assert.match(result.problems.join(' '), /identidad local/);
});
