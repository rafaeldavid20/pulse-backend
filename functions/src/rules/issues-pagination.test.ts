import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, documentId, getDocs, limit, orderBy, query, setDoc, startAfter, where } from 'firebase/firestore';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required');
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({projectId:'demo-pulse-tes168', firestore:{rules:readFileSync(resolve(__dirname,'../../../firestore.rules'),'utf8')}});
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all(Array.from({length:65}, (_,i) => setDoc(doc(db,'issues',`a-${String(i).padStart(2,'0')}`), {workspaceId:'a',teamId:'team-a',updatedAt:'2026-11-01T00:00:00.000Z'})));
    await setDoc(doc(db,'issues','other-team'), {workspaceId:'a',teamId:'team-b',updatedAt:'2026-11-01T00:00:00.000Z'});
    await setDoc(doc(db,'issues','other-workspace'), {workspaceId:'b',teamId:'team-a',updatedAt:'2026-11-01T00:00:00.000Z'});
  });
});
after(async () => { await env.cleanup(); });
test('team and workspace filters satisfy rules, page stably, and retain the full live window', async () => {
  const db = env.authenticatedContext('alice',{ws:{a:'member'}}).firestore();
  const base = [where('workspaceId','==','a'), where('teamId','==','team-a'), orderBy('updatedAt','desc'), orderBy(documentId(),'desc')];
  const first = await assertSucceeds(getDocs(query(collection(db,'issues'),...base,limit(50))));
  const last = first.docs.at(-1)!;
  const second = await assertSucceeds(getDocs(query(collection(db,'issues'),...base,startAfter(last.data().updatedAt,last.id),limit(50))));
  assert.equal(first.size,50); assert.equal(second.size,15);
  assert.equal(new Set([...first.docs,...second.docs].map(d => d.id)).size,65);
  const live = await assertSucceeds(getDocs(query(collection(db,'issues'),where('workspaceId','==','a'),where('teamId','==','team-a'),where('updatedAt','>=','2026-10-01'),orderBy('updatedAt','desc'),orderBy(documentId(),'desc'))));
  assert.equal(live.size,65);
  await assertFails(getDocs(query(collection(db,'issues'),where('teamId','==','team-a'))));
  await assertFails(getDocs(query(collection(db,'issues'),where('workspaceId','==','b'),where('teamId','==','team-a'))));
});
