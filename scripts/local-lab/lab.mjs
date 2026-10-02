#!/usr/bin/env node
// Local-only lab: synthetic keys, isolated Runner homes, no deploy commands.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, cp, symlink, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(process.env.PULSE_LAB_APP || join(backend, '../pulse-app-tes-304-preflight'));
const runner = resolve(process.env.PULSE_LAB_RUNNER || join(backend, '../pulse-runner-tes-304-preflight'));
const home = join(backend, '.emulator-data/local-lab');
const project = 'demo-pulse-local', workspaceId = 'ws-aVEruGM7', repo = 'pulse-local/fixture';
const endpoint = `http://127.0.0.1:5001/${project}/us-east4`;
const require = createRequire(join(backend, 'functions/package.json'));
const children = new Set();
function exec(bin, args, options = {}) {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { cwd: backend, stdio: 'inherit', ...options });
    children.add(child);
    child.on('error', rej);
    child.on('exit', code => { children.delete(child); code === 0 ? res() : rej(new Error(`${bin} exited ${code}`)); });
  });
}
async function save(path, value) { await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); }
async function state() { return JSON.parse(await readFile(join(home, 'state.json'), 'utf8')); }
async function prepare() {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await exec('npm', ['run', 'build'], { cwd: join(backend, 'functions') });
  const source = join(home, 'functions');
  await mkdir(source, { recursive: true, mode: 0o700 });
  await cp(join(backend, 'functions/lib'), join(source, 'lib'), { recursive: true });
  await cp(join(backend, 'functions/package.json'), join(source, 'package.json'));
  try { await access(join(source, 'node_modules')); } catch { await symlink(join(backend, 'functions/node_modules'), join(source, 'node_modules'), 'dir'); }
  let s;
  try { s = await state(); } catch {
    const signing = generateKeyPairSync('ed25519');
    s = { pepper: randomBytes(32).toString('hex'), signingPrivate: signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), signingPublic: signing.publicKey.export({ type: 'spki', format: 'pem' }) };
    await save(join(home, 'state.json'), s);
  }
  const secretsSource = await readFile(join(backend, 'functions/src/common/secrets.ts'), 'utf8');
  const secrets = Object.fromEntries([...secretsSource.matchAll(/defineSecret\('([^']+)'\)/g)].map(m => [m[1], 'local-placeholder']));
  Object.assign(secrets, { MCP_KEY_PEPPER: s.pepper, RUNNER_JOB_SIGNING_PRIVATE_KEY: s.signingPrivate, PULSE_ARGUS_DSN: '', GITHUB_APP_ID: '0', SALESFORCE_TOKEN_KEY: randomBytes(32).toString('base64') });
  await save(join(source, '.secret.local'), Object.entries(secrets).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');
  await cp(join(backend, 'firestore.rules'), join(home, 'firestore.rules'));
  await cp(join(backend, 'firestore.indexes.json'), join(home, 'firestore.indexes.json'));
  const config = { functions: [{ source: 'functions', codebase: 'default' }], firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' }, emulators: { auth: { host: '127.0.0.1', port: 9099 }, firestore: { host: '127.0.0.1', port: 8080 }, functions: { host: '127.0.0.1', port: 5001 }, ui: { enabled: true, host: '127.0.0.1', port: 4000 }, singleProjectMode: true } };
  await save(join(home, 'firebase.json'), config);
}
function admin() {
  // This module never initializes Admin SDK until emulator hosts are pinned.
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
  process.env.GCLOUD_PROJECT = project;
  const sdk = require('firebase-admin');
  if (!sdk.apps.length) sdk.initializeApp({ projectId: project });
  return sdk;
}
async function login(uid = 'local-owner') {
  const response = await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-only`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${uid}@pulse.test`, password: 'PulseLocal123!', returnSecureToken: true }) });
  const value = await response.json();
  if (!value.idToken) throw new Error('Local login failed; start emulators and seed first.');
  return value.idToken;
}
async function action(actionCode, data, uid = 'local-owner') {
  const response = await fetch(`${endpoint}/pulsePlatformAction`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await login(uid)}` }, body: JSON.stringify({ data: { actionCode, data } }) });
  const value = await response.json();
  if (!response.ok || value.error || !value.result?.success) throw new Error(value.error?.message || value.result?.error || `Local action failed: ${actionCode}`);
  return value.result.data;
}
async function seed() {
  const sdk = admin(), db = sdk.firestore(), auth = sdk.auth(), now = new Date().toISOString();
  const s = await state();
  for (const [uid, role] of [['local-admin','admin'], ['local-owner','member'], ['local-other','member'], ['local-outsider','member']]) {
    try { await auth.createUser({ uid, email: `${uid}@pulse.test`, password: 'PulseLocal123!', displayName: uid }); } catch (e) { if (e.code !== 'auth/uid-already-exists' && e.code !== 'auth/email-already-exists') throw e; }
    const ws = uid === 'local-outsider' ? 'ws-local-other' : workspaceId;
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@pulse.test`, displayName: uid, workspaceIds: [ws], createdAt: now });
    await db.doc(`members/${ws}_${uid}`).set({ id: `${ws}_${uid}`, workspaceId: ws, userId: uid, email: `${uid}@pulse.test`, displayName: uid, role, joinedAt: now });
    await auth.setCustomUserClaims(uid, { ws: { [ws]: role } });
  }
  for (const id of [workspaceId, 'ws-local-other']) await db.doc(`workspaces/${id}`).set({ id, name: `Pulse local (${id})`, slug: id, ownerId: 'local-admin', createdAt: now });
  await db.doc('teams/team-local').set({ id: 'team-local', workspaceId, name: 'Local E2E', key: 'TES', createdAt: now });
  await db.doc('projects/proj-local').set({ id: 'proj-local', workspaceId, teamId: 'team-local', name: 'Runner lab', status: 'in_progress', repoFullName: repo, repos: [repo], agentsPaused: true, definitionOfDone: [], createdAt: now, updatedAt: now });
  // Local bare Git remote: even live providers fetch/push only this fixture.
  const git = join(home, 'fixture');
  try { await access(join(home, 'fixture.git')); } catch {
    await mkdir(git, { recursive: true });
    await exec('git', ['init', '-b', 'main', git]);
    await save(join(git, 'README.md'), '# Pulse local fixture\nRead-only Runner smoke. Do not create commits or PRs.\n');
    await exec('git', ['-C', git, 'add', 'README.md']);
    await exec('git', ['-C', git, '-c', 'user.name=Pulse Local', '-c', 'user.email=local@pulse.test', 'commit', '-m', 'Local fixture']);
    await exec('git', ['clone', '--bare', git, join(home, 'fixture.git')]);
  }
  s.runners ||= {};
  for (const kind of ['codex', 'claude']) {
    const identities = ['dev','qa'].map(role => ({ agentId: `local-${kind}-${role}`, kind, role }));
    const pair = generateKeyPairSync('ed25519');
    const previous = s.runners[kind];
    const registered = previous && (await db.doc(`runners/${previous.id}`).get()).exists
      ? { runner: { id: previous.id }, deviceCredential: await readFile(join(previous.home, 'device-credential'), 'utf8') }
      : await action('runners.register', { workspaceId, displayName: `Lab ${kind}`, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }), connectedRepos: [repo] });
    const dir = join(home, `runner-${kind}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await save(join(dir, 'config.json'), { workspaceId, agentId: identities[0].agentId, agentKind: kind, agentRole: 'dev', identities, runnerId: registered.runner.id, signingPublicKey: s.signingPublic, signingKeyId: 'runner-job-v1', repos: [repo], endpoint, autonomousConfirmed: true });
    await save(join(dir, 'device-credential'), registered.deviceCredential);
    s.runners[kind] = { id: registered.runner.id, home: dir };
    for (const identity of identities) {
      const id = identity.agentId;
      await db.doc(`agents/${id}`).set({ id, workspaceId, kind, role: identity.role, displayName: `Lab ${kind} ${identity.role}`, ownerMemberId: 'local-owner', visibility: 'personal', runnerId: registered.runner.id, defaultRepo: repo, reviewRepo: repo, defaultTeamId: 'team-local', allowedRepos: [repo], connectedRepos: [{ repoFullName: repo, connectedAt: now }], enabled: true, autonomousMode: false, maxConcurrentIssues: 1, maxReviewAttempts: 2, qaMode: 'shadow', createdAt: now });
      await db.doc(`members/${workspaceId}_${id}`).set({ id: `${workspaceId}_${id}`, userId: id, workspaceId, displayName: id, email: '', role: 'member', isAgent: true, agentKind: kind, agentRole: identity.role, joinedAt: now });
    }
    const id = `issue-local-${kind}`;
    await db.doc(`issues/${id}`).set({ id, identifier: kind === 'codex' ? 'TES-9001' : 'TES-9002', workspaceId, teamId: 'team-local', projectId: 'proj-local', title: `Read-only ${kind} smoke`, description: 'Only read this issue through Pulse MCP and README.md. Report success. Do not edit files, create commits, publish PRs, or contact any external service.', status: 'backlog', priority: 0, type: 'task', responsibleMemberId: 'local-owner', assigneeId: `local-${kind}-dev`, execution: { agentId: `local-${kind}-dev` }, gitRefs: [{ repoFullName: repo, prNumber: 1 }], createdAt: now, updatedAt: now });
  }
  const { generateApiKey, hashApiKeySecret } = require(join(backend, 'functions/lib/common/utils/api-key.js'));
  const key = generateApiKey();
  await db.doc(`api_keys/${key.keyId}`).set({ workspaceId, agentId: null, createdBy: 'local-owner', scopes: ['issues:read', 'comments:read', 'reviews:read', 'runs:read'], hash: hashApiKeySecret(key.secret, s.pepper), createdAt: now });
  await save(join(home, 'mcp-token'), key.fullKey);
  await save(join(home, 'state.json'), s);
  console.log('Seed ready: local-owner@pulse.test / PulseLocal123! (admin, other, outsider use the same password).');
}
function runnerEnv(s, kind, live = false) {
  return { ...process.env, PULSE_RUNNER_HOME: s.runners[kind].home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${join(home, 'fixture.git')}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/${repo}.git`, ...(live ? {} : { PULSE_RUNNER_CODEX_BIN: join(backend, 'scripts/local-lab/provider.mjs'), PULSE_RUNNER_CLAUDE_BIN: join(backend, 'scripts/local-lab/provider.mjs') }) };
}
async function runRunner(kind, args, live = false) { await exec(process.execPath, [join(runner, 'src/index.js'), ...args], { env: runnerEnv(await state(), kind, live) }); }
async function check() {
  const s = await state(), db = admin().firestore();
  delete process.env.PULSE_LAB_FAIL;
  for (const kind of ['codex','claude']) {
    await runRunner(kind, ['diagnose']);
    for (const role of ['dev','qa']) {
      assert.equal((await action('runners.preflight', { agentId: `local-${kind}-${role}`, repos: [repo] })).ready, true);
      assert.equal((await action('runners.preflight', { agentId: `local-${kind}-${role}`, repos: [repo] }, 'local-admin')).ready, true);
    }
    await assert.rejects(action('runners.preflight', { agentId: `local-${kind}-dev`, repos: [repo] }, 'local-other'));
    await assert.rejects(action('runners.preflight', { agentId: `local-${kind}-dev`, repos: [repo] }, 'local-outsider'));
    const denied = await action('runners.preflight', { agentId: `local-${kind}-dev`, repos: ['pulse-local/forbidden'] });
    assert.equal(denied.ready, false);
    const ref = db.doc(`runners/${s.runners[kind].id}`);
    const prepared = (await ref.get()).data();
    try {
    await ref.update({ [`readiness.providers.${kind}.session`]: false });
    assert.ok((await action('runners.preflight', { agentId: `local-${kind}-dev`, repos: [repo] })).problems.some(p => p.code === 'session'));
    await ref.update({ readiness: prepared.readiness });
    await ref.update({ 'readiness.identities': [] });
    assert.ok((await action('runners.preflight', { agentId: `local-${kind}-qa`, repos: [repo] })).problems.some(p => p.code === 'identity'));
    await ref.update({ readiness: prepared.readiness });
    } finally { await ref.update({ readiness: prepared.readiness }); }
    const { job } = await action('runners.issueJob', { issueId: `issue-local-${kind}`, repoFullName: repo });
    assert.equal((await action('runners.preflight', { agentId: `local-${kind}-dev`, repos: [repo] })).ready, false);
    await runRunner(kind, ['run','--once']);
    const complete = (await db.doc(`runner_jobs/${job.id}`).get()).data();
    assert.equal(complete.status, 'completed', JSON.stringify(complete.failure));
    assert.equal(complete.result, 'Agent completed');
    const keys = await db.collection('api_keys').where('jobId', '==', job.id).get();
    assert.equal(keys.size, 1); assert.ok(keys.docs[0].data().revokedAt);
    const failureJob = await action('runners.issueJob', { issueId: `issue-local-${kind}`, repoFullName: repo });
    process.env.PULSE_LAB_FAIL = '1';
    try { await runRunner(kind, ['run','--once']); } finally { delete process.env.PULSE_LAB_FAIL; }
    const failed = (await db.doc(`runner_jobs/${failureJob.job.id}`).get()).data();
    assert.equal(failed.status, 'failed'); assert.equal(failed.failure.phase, 'run-agent'); assert.equal(failed.failure.category, 'execution');
    assert.equal(failed.failure.correlationId, failureJob.job.id);
    assert.ok(!failed.result.includes('ghp_abcdefghijklmnopqrstuvwxyz1234567890'));
    const retry = await action('runners.retryJob', { jobId: failureJob.job.id });
    assert.equal(retry.job.retryOf, failureJob.job.id);
    await runRunner(kind, ['run','--once']);
    assert.equal((await db.doc(`runner_jobs/${retry.job.id}`).get()).data().status, 'completed');
    // QA transport check: dispatch uses the same central validation, with a
    // fixture PR reference. This does not pretend to test a GitHub QA verdict.
    const { enqueueRunnerJob } = require(join(backend, 'functions/lib/common/utils/runner-jobs.js'));
    const qa = await enqueueRunnerJob(db, { workspaceId, issueId: `issue-local-${kind}`, agentId: `local-${kind}-qa`, runnerId: s.runners[kind].id, repoFullName: repo, mode: 'review' }, s.signingPrivate);
    await db.doc(`agent_runs/${qa.id}`).set({ id: qa.id, workspaceId, issueId: qa.issueId, agentId: qa.agentId, runnerId: qa.runnerId, role: 'qa', startedAt: new Date().toISOString() });
    await runRunner(kind, ['run','--once']);
    assert.equal((await db.doc(`runner_jobs/${qa.id}`).get()).data().status, 'completed');
    console.log(`PASS ${kind}: Dev/QA preflight, ownership/workspace, repo/capacity block, signed job → MCP → completion → credential revocation, structured failure/retry, QA transport.`);
  }
  console.log('Local smoke passed. Real provider sessions and UI acceptance remain separate checks.');
}
const command = process.argv[2] || 'help';
if (command === 'start') {
  await prepare();
  process.on('SIGINT', () => { for (const child of children) child.kill('SIGINT'); });
  process.on('SIGTERM', () => { for (const child of children) child.kill('SIGTERM'); });
  await exec('firebase', ['emulators:start','--config',join(home,'firebase.json'),'--project',project,'--only','auth,firestore,functions'], { env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '', GCLOUD_PROJECT: project } });
} else if (command === 'web') {
  await exec('npm', ['run','dev','--','--hostname','127.0.0.1','--port','3000'], { cwd: app, env: { ...process.env, NEXT_PUBLIC_USE_EMULATORS: 'true', NEXT_PUBLIC_FIREBASE_PROJECT_ID: project, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: `${project}.firebaseapp.com`, NEXT_PUBLIC_FIREBASE_API_KEY: 'local-only', NEXT_PUBLIC_FIREBASE_APP_ID: 'local-only', NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: `${project}.appspot.com`, NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '0' } });
} else if (command === 'seed') await seed();
else if (command === 'check') await check();
else if (command === 'runner') await runRunner(process.argv[3] || 'codex', process.argv.slice(4).filter(a => a !== '--live').length ? process.argv.slice(4).filter(a => a !== '--live') : ['start'], process.argv.includes('--live'));
else console.log('node scripts/local-lab/lab.mjs start|seed|web|check|runner codex|claude [diagnose|start|run --once] [--live]');
