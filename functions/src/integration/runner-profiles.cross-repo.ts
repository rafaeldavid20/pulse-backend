import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { manageRunnerProfile, exchangeRunnerProfiles } from '../runners/profiles';
import { RunnerProfileAction } from '../actions/runners/profile';
import { UpdateAgentAction } from '../actions/agents/update-agent';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'demo-pulse-local' });
const db = getFirestore();
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
const runnerRoot = process.env.PULSE_RUNNER_SOURCE || [resolve(process.cwd(), '../../pulse-runner'), resolve(process.cwd(), '../../rafaeldavid20__pulse-runner')].find(path => existsSync(join(path, 'src/remote-profile.js')));
if (!runnerRoot) throw new Error('Set PULSE_RUNNER_SOURCE to the coordinated pulse-runner checkout.');

async function fixture(run: (f: any) => Promise<void>) {
  const suffix = randomUUID(); const workspaceId = `ws-${suffix}`; const agentId = `agent-${suffix}`; const runnerId = `runner-${suffix}`;
  const owner = `owner-${suffix}`; const other = `other-${suffix}`; const admin = `admin-${suffix}`;
  const now = new Date().toISOString();
  for (const [uid, role] of [[owner, 'member'], [other, 'member'], [admin, 'admin']]) await db.collection('members').doc(`${workspaceId}_${uid}`).set({ workspaceId, userId: uid, role });
  await db.collection('agents').doc(agentId).set({ workspaceId, runnerId, kind: 'codex', role: 'dev', visibility: 'personal', ownerMemberId: owner });
  await db.collection('runners').doc(runnerId).set({ workspaceId, ownerMemberId: owner, status: 'online', lastHeartbeatAt: now });
  await db.collection('projects').doc(workspaceId).set({ workspaceId, repoFullNames: ['owner/repo', 'owner/uninstalled'] });
  await db.collection('github_installations').doc(workspaceId).set({ workspaceId, repositoryFullNames: ['owner/repo'] });
  const root = await mkdtemp(join(tmpdir(), 'profile-emulator-')); const prior = process.env.PULSE_RUNNER_HOME; process.env.PULSE_RUNNER_HOME = root;
  const remote = await importModule(pathToFileURL(join(runnerRoot!, 'src/remote-profile.js')).href);
  const local = await importModule(pathToFileURL(join(runnerRoot!, 'src/config.js')).href);
  const id = `dir-${'e'.repeat(64)}`; const sensitive = '/Users/SENSITIVE_FIXTURE/checkout';
  await local.writeProfiles({ [`${workspaceId}:${agentId}`]: { directories: {}, checkouts: { 'owner/repo': [{ id, path: sensitive }] } } });
  const config = { workspaceId, agentId, runnerId, agentKind: 'codex', repos: ['owner/repo'] };
  const deps = { models: async () => ['model-one'], validateRepo: async (_c: any, _r: string, path: string) => path };
  const wire: any[] = [];
  const exchange = async (_c: any, _path: string, body: any) => { wire.push(body); const response = await exchangeRunnerProfiles(db, runnerId, body); wire.push(response); return response; };
  const read = (requestId?: string, actor = owner, target = runnerId) => manageRunnerProfile(db, actor, { agentId, runnerId: target, op: 'read', ...(requestId ? { requestId } : {}) });
  try { await run({ workspaceId, agentId, runnerId, owner, other, admin, id, sensitive, config, deps, remote, local, exchange, read, wire }); }
  finally { if (prior === undefined) delete process.env.PULSE_RUNNER_HOME; else process.env.PULSE_RUNNER_HOME = prior; await rm(root, { recursive: true, force: true }); }
}

test('backend + real Runner module: confirmed apply, lost acknowledgement, idempotency and metadata privacy', () => fixture(async f => {
  assert.equal((await f.read()).snapshot, null);
  assert.equal((await f.read()).capable, false); // Legacy Runner: update required.
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  const initial = await f.read(); assert.deepEqual(initial.repos, ['owner/repo']);
  const requestId = randomUUID();
  const input = { agentId: f.agentId, runnerId: f.runnerId, op: 'request', requestId, expectedRevision: initial.snapshot.revision, patch: { model: 'model-one', directories: [{ repo: 'owner/repo', candidateId: f.id }] } };
  assert.equal((await manageRunnerProfile(db, f.owner, input)).status, 'applying');
  assert.equal((await f.read(requestId)).snapshot.model, null);
  let lose = true;
  const dropped = async (c: any, path: string, body: any) => {
    if (body.profiles?.[0]?.result && lose) { lose = false; throw new Error('lost before confirmation'); }
    return f.exchange(c, path, body);
  };
  await assert.rejects(f.remote.syncRemoteProfiles(f.config, dropped, f.deps), /lost/);
  assert.equal((await f.read(requestId)).request.status, 'applying');
  assert.equal((await f.local.readProfiles())[`${f.workspaceId}:${f.agentId}`].model, 'model-one');
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  const confirmed = await f.read(requestId); assert.equal(confirmed.request.status, 'applied'); assert.equal(confirmed.snapshot.model, 'model-one');
  assert.equal((await manageRunnerProfile(db, f.owner, input)).status, 'applied');
  await assert.rejects(manageRunnerProfile(db, f.owner, { ...input, patch: { model: null } }), /ID/);
  const persisted = await Promise.all(['runner_profiles', 'runner_profile_requests', 'platform_actions'].map(name => db.collection(name).get().then(s => s.docs.map(d => d.data()))));
  for (const payload of [f.wire, persisted]) { const text = JSON.stringify(payload); assert.equal(text.includes(f.sensitive), false); assert.equal(text.includes('SENSITIVE_FIXTURE'), false); }
}));

test('backend permission boundaries, public agents, candidate scope and rebinding', () => fixture(async f => {
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  await assert.rejects(f.read(undefined, f.other), /dueño/);
  assert.ok(await f.read(undefined, f.admin));
  await db.collection('agents').doc(f.agentId).update({ visibility: 'public' });
  await assert.rejects(f.read(), /dueño/);
  await db.collection('agents').doc(f.agentId).update({ visibility: 'personal' });
  const initial = await f.read();
  const input = { agentId: f.agentId, runnerId: f.runnerId, op: 'request', requestId: randomUUID(), expectedRevision: initial.snapshot.revision, patch: { directories: [{ repo: 'owner/foreign', candidateId: f.id }] } };
  await assert.rejects(manageRunnerProfile(db, f.owner, input), /Candidato/);
  await db.collection('runners').doc('runner-other-workspace').set({ workspaceId: 'foreign', ownerMemberId: f.owner });
  await assert.rejects(f.read(undefined, f.owner, 'runner-other-workspace'), /Vínculo/);
  const accepted = { ...input, requestId: randomUUID(), patch: { model: 'model-one' } };
  await manageRunnerProfile(db, f.owner, accepted);
  await db.collection('members').doc(`${f.workspaceId}_${f.owner}`).delete();
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  assert.equal((await f.read(accepted.requestId, f.admin)).request.status, 'forbidden');
  const runner2 = `runner2-${randomUUID()}`;
  await db.collection('runners').doc(runner2).set({ workspaceId: f.workspaceId, ownerMemberId: f.owner, status: 'online', lastHeartbeatAt: new Date().toISOString() });
  await db.collection('members').doc(`${f.workspaceId}_${f.owner}`).set({ role: 'member', workspaceId: f.workspaceId });
  const action = (runnerId: string) => new UpdateAgentAction({ actionCode: 'agents.update', data: { agentId: f.agentId, runnerId } }, f.owner).run();
  assert.equal((await action(runner2)).success, true);
  assert.equal((await f.read(undefined, f.owner, runner2)).snapshot, null);
  await assert.rejects(f.read(), /Vínculo/);
  assert.equal((await action(f.runnerId)).success, true);
  assert.equal((await f.read()).snapshot, null); // Old binding confirmation is not reused.
}));

test('conflicts, atomic validation failure, disconnected admission and sanitized audit', () => fixture(async f => {
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  let initial = await f.read();
  const input = (patch: any) => ({ agentId: f.agentId, runnerId: f.runnerId, op: 'request', requestId: randomUUID(), expectedRevision: initial.snapshot.revision, patch });
  const conflict = input({ model: 'model-one' }); await manageRunnerProfile(db, f.owner, conflict);
  const all = await f.local.readProfiles(); all[`${f.workspaceId}:${f.agentId}`].model = 'local'; await f.local.writeProfiles(all);
  await f.remote.syncRemoteProfiles(f.config, f.exchange, f.deps);
  assert.equal((await f.read(conflict.requestId)).request.status, 'conflict');
  initial = await f.read();
  const invalid = input({ model: 'model-one', directories: [{ repo: 'owner/repo', candidateId: f.id }] }); await manageRunnerProfile(db, f.owner, invalid);
  await f.remote.syncRemoteProfiles(f.config, f.exchange, { ...f.deps, validateRepo: async () => { throw new Error('/Users/SENSITIVE_FIXTURE/pulse_sk_synthetic'); } });
  assert.equal((await f.read(invalid.requestId)).request.status, 'validation_failed');
  assert.equal((await f.local.readProfiles())[`${f.workspaceId}:${f.agentId}`].model, 'local');
  await db.collection('runners').doc(f.runnerId).update({ lastHeartbeatAt: '2000-01-01T00:00:00Z' });
  assert.equal((await f.read()).online, false); assert.ok((await f.read()).snapshot);
  await assert.rejects(manageRunnerProfile(db, f.owner, input({ model: null })), /desconectado/);
  const action = new RunnerProfileAction({ actionCode: 'runners.profile', data: { agentId: f.agentId, runnerId: f.runnerId, op: 'request', patch: { model: '/Users/SENSITIVE_FIXTURE/pulse_sk_synthetic' } } }, f.owner);
  assert.equal((await action.run()).success, false);
  const audit = JSON.stringify((await db.collection('platform_actions').get()).docs.map(d => d.data()));
  assert.equal(audit.includes('SENSITIVE_FIXTURE'), false); assert.equal(audit.includes('pulse_sk_synthetic'), false);
}));

test('two agents on one Runner retain independent profiles and serialize concurrent submissions', () => fixture(async f => {
  const secondId = `second-${randomUUID()}`;
  await db.collection('agents').doc(secondId).set({ workspaceId: f.workspaceId, runnerId: f.runnerId, kind: 'codex', role: 'dev', visibility: 'personal', ownerMemberId: f.owner });
  const config = { ...f.config, identities: [{ agentId: f.agentId, kind: 'codex', role: 'dev' }, { agentId: secondId, kind: 'codex', role: 'dev' }] };
  await f.remote.syncRemoteProfiles(config, f.exchange, f.deps);
  const initial = await f.read();
  const make = () => ({ agentId: f.agentId, runnerId: f.runnerId, op: 'request', requestId: randomUUID(), expectedRevision: initial.snapshot.revision, patch: { model: 'model-one' } });
  const results = await Promise.allSettled([manageRunnerProfile(db, f.owner, make()), manageRunnerProfile(db, f.owner, make())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await f.remote.syncRemoteProfiles(config, f.exchange, f.deps);
  assert.equal((await f.read()).snapshot.model, 'model-one');
  const second = await manageRunnerProfile(db, f.owner, { agentId: secondId, runnerId: f.runnerId, op: 'read' });
  assert.ok('snapshot' in second);
  assert.equal(second.snapshot.model, null); assert.equal(second.snapshot.directories[0].candidates.length, 0);
  await assert.rejects(manageRunnerProfile(db, f.owner, { agentId: secondId, runnerId: f.runnerId, op: 'request', requestId: randomUUID(), expectedRevision: second.snapshot.revision, patch: { directories: [{ repo: 'owner/repo', candidateId: f.id }] } }), /Candidato/);
}));
