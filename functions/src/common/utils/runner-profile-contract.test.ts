import test from 'node:test';
import assert from 'node:assert/strict';
import { profileInput, profileSnapshot, profileOnline, profileKey } from './runner-profile-contract';

test('profile contract rejects arbitrary paths, unknown payload fields and foreign candidate formats', () => {
  const base = { agentId: 'agent-one', runnerId: 'runner-one', op: 'request', requestId: 'aa9ec19e-067a-4ced-9cf7-a5d1cdaf2a5e', expectedRevision: 'a'.repeat(64) };
  for (const patch of [{ path: '/Users/private' }, { model: '/Users/private' }, { directories: [{ repo: 'owner/repo', candidateId: '/Users/private' }] }, { directories: [{ repo: 'owner/repo', candidateId: null, token: 'synthetic-secret' }] }]) assert.equal(profileInput.safeParse({ ...base, patch }).success, false);
  assert.equal(profileInput.safeParse({ ...base, patch: { model: null, directories: [{ repo: 'owner/repo', candidateId: null }] } }).success, true);
  assert.notEqual(profileKey('ws-a', 'agent', 'runner'), profileKey('ws-b', 'agent', 'runner'));
  assert.notEqual(profileKey('ws', 'agent-a', 'runner'), profileKey('ws', 'agent-b', 'runner'));
});
test('snapshots accept only metadata and liveness expires even when status stays online', () => {
  const base = { version: 1, revision: 'a'.repeat(64), provider: 'codex', model: null, modelValid: true, models: [], directories: [{ repo: 'owner/repo', selected: null, valid: true, candidates: [{ id: `dir-${'b'.repeat(64)}`, alias: 'Checkout 1' }] }] };
  assert.equal(profileSnapshot.safeParse(base).success, true);
  assert.equal(profileSnapshot.safeParse({ ...base, files: 'private' }).success, false);
  assert.equal(profileSnapshot.safeParse({ ...base, directories: [{ ...base.directories[0], candidates: [{ ...base.directories[0].candidates[0], alias: '/Users/private' }] }] }).success, false);
  const now = Date.now(); const runner = { status: 'busy', lastHeartbeatAt: new Date(now).toISOString() };
  assert.equal(profileOnline(runner, now), true); assert.equal(profileOnline(runner, now + 121_000), false);
  assert.equal(profileOnline({ ...runner, revokedAt: 'now' }, now), false);
});
