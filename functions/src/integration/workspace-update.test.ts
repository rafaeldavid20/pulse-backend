import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { UpdateWorkspaceAction } from '../actions/workspaces/update-workspace';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
if (!getApps().length) initializeApp({ projectId: 'demo-pulse-workspace' });
const db = getFirestore();
let sequence = 0;
async function fixture() {
  const id = `rename-${process.pid}-${++sequence}`;
  const ref = db.collection('workspaces').doc(id);
  const workspace = { id, name: 'Original', slug: 'original', createdAt: '2026-01-01', agentsPaused: false };
  await ref.set(workspace);
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    await db.collection('members').doc(`${id}_${role}`).set({ workspaceId: id, userId: role, role });
  }
  const update = (data: Record<string, unknown>, uid?: string) => new UpdateWorkspaceAction({
    actionCode: 'workspaces.update', data: { workspaceId: id, ...data },
  }, uid).run();
  return { ref, workspace, update };
}

for (const role of ['admin', 'owner']) {
  test(`${role} renames; document listener observes name while identity stays intact`, async () => {
    const { ref, workspace, update } = await fixture();
    let stop: (() => void) | undefined;
    const observed = new Promise<void>((resolve, reject) => {
      stop = ref.onSnapshot(snap => { if (snap.data()?.name === 'Test Startup · TES-350') resolve(); }, reject);
    });
    try {
      const result = await update({ name: '  Test Startup · TES-350  ', slug: 'hacked', id: 'hacked' }, role);
      assert.equal(result.success, true);
      assert.deepEqual(result.data?.workspace, { ...workspace, name: 'Test Startup · TES-350' });
      await observed;
    } finally { stop?.(); }
  });
}
for (const uid of ['member', 'viewer', 'outsider', undefined]) {
  test(`rejects caller ${uid ?? 'unauthenticated'} without modifying workspace`, async () => {
    const { ref, workspace, update } = await fixture();
    const result = await update({ name: 'Forbidden' }, uid);
    assert.equal(result.success, false);
    assert.match(result.error!, /no autorizado/);
    assert.deepEqual((await ref.get()).data(), workspace);
  });
}
for (const name of ['', '   ', null, 42, 'x'.repeat(101), 'Bad\nname', '\u0000']) {
  test(`rejects invalid name ${JSON.stringify(name)}`, async () => {
    const { ref, workspace, update } = await fixture();
    const result = await update({ name, agentsPaused: true }, 'admin');
    assert.equal(result.success, false);
    assert.match(result.error!, /nombre del workspace/);
    assert.deepEqual((await ref.get()).data(), workspace);
  });
}
for (const data of [{}, { slug: 'hacked' }, { name: undefined }]) {
  test(`rejects empty editable update ${JSON.stringify(data)}`, async () => {
    const { ref, workspace, update } = await fixture();
    const result = await update(data, 'owner');
    assert.equal(result.success, false);
    assert.match(result.error!, /al menos un campo editable/);
    assert.deepEqual((await ref.get()).data(), workspace);
  });
}
test('guardrails still work and invalid combined updates are atomic', async () => {
  const { ref, update } = await fixture();
  assert.equal((await update({ agentsPaused: true, dailyDispatchLimit: 3 }, 'admin')).success, true);
  const before = (await ref.get()).data();
  assert.equal((await update({ name: 'New', dailyDispatchLimit: 0 }, 'admin')).success, false);
  assert.deepEqual((await ref.get()).data(), before);
});

test('Firestore rules reject direct client rename even for an authenticated admin', async () => {
  const { ref, workspace } = await fixture();
  const project = 'demo-pulse-workspace';
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Unsigned identity is accepted only by the local emulator; no real credentials.
  const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    sub: 'admin', user_id: 'admin', aud: project, iss: `https://securetoken.google.com/${project}`,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    firebase: { sign_in_provider: 'custom' }, ws: { [ref.id]: 'admin' },
  })}.`;
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents/workspaces/${ref.id}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { headers })).status, 200);
  const result = await fetch(`${url}?updateMask.fieldPaths=name`, {
    method: 'PATCH', headers, body: JSON.stringify({ fields: { name: { stringValue: 'Direct rename' } } }),
  });
  assert.equal(result.status, 403);
  assert.deepEqual((await ref.get()).data(), workspace);
});
