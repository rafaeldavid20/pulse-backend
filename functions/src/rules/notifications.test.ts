import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required; production is never used.');
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-pulse-tes333',
    firestore: { rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8') },
  });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [id, workspaceId, userId] of [['mine-a', 'a', 'alice'], ['mine-b', 'b', 'alice'], ['foreign-a', 'a', 'bob']]) {
      await setDoc(doc(db, 'notifications', id), { id, workspaceId, userId, read: false, createdAt: '2026-10-14' });
    }
    await setDoc(doc(db, 'issues', 'issue-a'), { workspaceId: 'a' });
    await setDoc(doc(db, 'projects', 'project-a'), { workspaceId: 'a' });
  });
});
after(async () => { await env?.cleanup(); });
const alice = (ws: Record<string, string>) => env.authenticatedContext('alice', { ws }).firestore();
const notifications = (db: ReturnType<typeof alice>, workspaceId: string) => query(
  collection(db, 'notifications'), where('userId', '==', 'alice'), where('workspaceId', '==', workspaceId),
);

test('personal notification queries without a workspace are denied, matching the production regression', async () => {
  await assertFails(getDocs(query(collection(alice({ a: 'member' }), 'notifications'), where('userId', '==', 'alice'))));
});
test('scoped Inbox and unread badge return only the user notifications', async () => {
  const db = alice({ a: 'member' });
  const inbox = await assertSucceeds(getDocs(notifications(db, 'a')));
  assert.deepEqual(inbox.docs.map(item => item.id), ['mine-a']);
  const unread = await assertSucceeds(getDocs(query(notifications(db, 'a'), where('read', '==', false))));
  assert.equal(unread.size, 1);
});
test('several authorized workspaces can be queried separately without exposing another user', async () => {
  const db = alice({ a: 'owner', b: 'member' });
  const results = await Promise.all(['a', 'b'].map(id => assertSucceeds(getDocs(notifications(db, id)))));
  assert.deepEqual(results.flatMap(result => result.docs.map(item => item.id)).sort(), ['mine-a', 'mine-b']);
  await assertFails(getDoc(doc(db, 'notifications', 'foreign-a')));
});
test('a user cannot read their own notification outside an authorized workspace', async () => {
  const db = alice({ a: 'member' });
  await assertFails(getDocs(notifications(db, 'b')));
  await assertFails(getDoc(doc(db, 'notifications', 'mine-b')));
});
test('granting membership permits reopening a listener that previously failed', async () => {
  await new Promise<void>((resolve, reject) => {
    const stop = onSnapshot(notifications(alice({}), 'a'), () => reject(new Error('Unauthorized listener succeeded')), error => {
      stop();
      try { assert.equal(error.code, 'permission-denied'); resolve(); } catch (failure) { reject(failure); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const stop = onSnapshot(notifications(alice({ a: 'member' }), 'a'), snapshot => {
      stop();
      try { assert.equal(snapshot.size, 1); resolve(); } catch (failure) { reject(failure); }
    }, reject);
  });
});
test('revoked membership on a refreshed token denies notifications, issues and projects', async () => {
  const db = alice({});
  for (const [path, id] of [['notifications', 'mine-a'], ['issues', 'issue-a'], ['projects', 'project-a']]) {
    await assertFails(getDoc(doc(db, path, id)));
  }
});
test('anonymous clients cannot read notification data', async () => {
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'notifications', 'mine-a')));
});
