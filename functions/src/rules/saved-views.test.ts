import test, { before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required.');
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-pulse-views', firestore: { rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const uid of ['alice', 'bob', 'admin']) await setDoc(doc(db, 'members', `a_${uid}`), { workspaceId: 'a', userId: uid });
    await setDoc(doc(db, 'members', 'b_alice'), { workspaceId: 'b', userId: 'alice' });
    await setDoc(doc(db, 'saved_views', 'alice-private'), { workspaceId: 'a', ownerId: 'alice', shared: false });
    await setDoc(doc(db, 'saved_views', 'bob-private'), { workspaceId: 'a', ownerId: 'bob', shared: false });
    await setDoc(doc(db, 'saved_views', 'alice-shared'), { workspaceId: 'a', ownerId: 'alice', shared: true });
    await setDoc(doc(db, 'saved_views', 'other'), { workspaceId: 'b', ownerId: 'alice', shared: true });
  });
});
after(async () => env.cleanup());
const asUser = (uid: string, ws: Record<string, string>) => env.authenticatedContext(uid, { ws }).firestore();
test('private, shared and guessed IDs respect live membership', async () => {
  const alice = asUser('alice', { a: 'member' }), bob = asUser('bob', { a: 'member' }), admin = asUser('admin', { a: 'admin' });
  await assertSucceeds(getDoc(doc(alice, 'saved_views', 'alice-private')));
  await assertFails(getDoc(doc(bob, 'saved_views', 'alice-private')));
  await assertFails(getDoc(doc(admin, 'saved_views', 'alice-private')));
  await assertSucceeds(getDoc(doc(bob, 'saved_views', 'alice-shared')));
  await assertFails(getDoc(doc(alice, 'saved_views', 'other')));
  await assertFails(getDoc(doc(asUser('outsider', { a: 'member' }), 'saved_views', 'alice-shared')));
  await assertFails(setDoc(doc(alice, 'saved_views', 'new'), { workspaceId: 'a', ownerId: 'alice', shared: true }));
});
test('sidebar queries only own and shared views, and broad enumeration is denied', async () => {
  const alice = asUser('alice', { a: 'member' });
  await assertSucceeds(getDocs(query(collection(alice, 'saved_views'), where('workspaceId', '==', 'a'), where('ownerId', '==', 'alice'))));
  await assertSucceeds(getDocs(query(collection(alice, 'saved_views'), where('workspaceId', '==', 'a'), where('shared', '==', true))));
  await assertFails(getDocs(query(collection(alice, 'saved_views'), where('workspaceId', '==', 'a'))));
});
