import test, { before, after } from 'node:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initializeTestEnvironment, assertFails, assertSucceeds, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required');
let env: RulesTestEnvironment;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-control-signals', firestore: { rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8') } });
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    for (const [path, id, data] of [
      ['runners','runner-a',{workspaceId:'ws-a', ownerMemberId:'alice',signalSessionId:'session-a', deviceSecretHash:'hash-a',signalCredentialHash:'hash-a'}],
      ['runners','runner-b',{workspaceId:'ws-b',signalSessionId:'session-b',deviceSecretHash:'hash-b',signalCredentialHash:'hash-b'}],
      ['agents','agent-a',{workspaceId:'ws-a',runnerId:'runner-a',ownerMemberId:'alice',visibility:'personal'}],
      ['issues','issue-a',{workspaceId:'ws-a'}],['issues','issue-b',{workspaceId:'ws-b'}],
      ['members','ws-a_alice',{role:'member'}],['members','ws-a_bob',{role:'member'}],['members','ws-a_admin',{role:'admin'}],
      ['runner_signals','runner-a',{jobs:1,profiles:1}],['runner_signals','runner-b',{jobs:1}],
      ['profile_signals','agent-a',{revision:1}],['issue_signals','issue-a',{revision:1}],['issue_signals','issue-b',{revision:1}],
    ] as const) await setDoc(doc(db,path,id),data);
  });
});
after(async () => env?.cleanup());
const device = (claims = {}) => env.authenticatedContext('runner-device:runner-a', {runnerDevice:true, runnerId:'runner-a',workspaceId:'ws-a',runnerSession:'session-a',...claims}).firestore();
test('device can get only its own signal, cannot enumerate, write or use broad legacy rules',async()=>{
  const db=device();
  await assertSucceeds(getDoc(doc(db,'runner_signals','runner-a')));
  await assertFails(getDoc(doc(db,'runner_signals','runner-b')));
  await assertFails(getDocs(collection(db,'runner_signals')));
  await assertFails(setDoc(doc(db,'runner_signals','runner-a'),{jobs:20}));
  for(const path of ['users','workspaces','members','teams','invitations','counters','issues','projects','agents','runner_jobs','runner_profiles','api_keys']) {
    await assertFails(getDoc(doc(db,path,'fixture')));
    await assertFails(setDoc(doc(db,path,'fixture'),{workspaceId:'ws-a'}));
  }
  await assertFails(getDoc(doc(env.authenticatedContext('runner-device:runner-a').firestore(),'members','ws-a_alice')));
  // A fabricated workspace membership in a device token grants no client access.
  await assertFails(getDoc(doc(device({ws:{'ws-a':'owner'}}),'issues','issue-a')));
});
test('wrong identity, session and workspace are denied',async()=>{
  for(const claims of [{runnerId:'runner-b'},{workspaceId:'ws-b'},{runnerSession:'old'}]) await assertFails(getDoc(doc(device(claims),'runner_signals','runner-a')));
  await assertFails(getDoc(doc(env.authenticatedContext('alice',{ws:{'ws-a':'owner'}}).firestore(),'runner_signals','runner-a')));
});
test('UI signals retain issue membership and current profile ownership/admin boundaries',async()=>{
  for(const uid of ['alice','admin']) await assertSucceeds(getDoc(doc(env.authenticatedContext(uid,{ws:{'ws-a':'member'}}).firestore(),'profile_signals','agent-a')));
  const bob=env.authenticatedContext('bob',{ws:{'ws-a':'member'}}).firestore();
  await assertFails(getDoc(doc(bob,'profile_signals','agent-a')));
  await assertSucceeds(getDoc(doc(bob,'issue_signals','issue-a')));
  await assertFails(getDoc(doc(bob,'issue_signals','issue-b')));
  // Nonexistent signal reads are allowed for authorized initial subscriptions.
  await env.withSecurityRulesDisabled(c=>setDoc(doc(c.firestore(),'issues','new-issue'),{workspaceId:'ws-a'}));
  await assertSucceeds(getDoc(doc(bob,'issue_signals','new-issue')));
  await assertFails(setDoc(doc(bob,'issue_signals','issue-a'),{revision:9}));
});
test('revocation and credential rotation deny a previously valid session',async()=>{
  await env.withSecurityRulesDisabled(c=>updateDoc(doc(c.firestore(),'runners','runner-a'),{deviceSecretHash:'rotated'}));
  await assertFails(getDoc(doc(device(),'runner_signals','runner-a')));
  await env.withSecurityRulesDisabled(c=>updateDoc(doc(c.firestore(),'runners','runner-a'),{deviceSecretHash:'hash-a',revokedAt:'now'}));
  await assertFails(getDoc(doc(device(),'runner_signals','runner-a')));
});
