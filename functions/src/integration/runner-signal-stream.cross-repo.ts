import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { pathToFileURL } from 'url';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { signalRunner, runnerSubscriptionSession } from '../runners/signals';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('Auth + Firestore emulators required');
const importModule = new Function('url','return import(url)') as (url:string)=>Promise<any>;
test('real device custom-token sign-in receives persisted signals, reconnects, and rejects revoked credentials',async()=>{
  const projectId='demo-runner-signal-stream';
  const env=await initializeTestEnvironment({projectId,firestore:{rules:readFileSync(resolve(__dirname,'../../../firestore.rules'),'utf8')}});
  const app=initializeApp({projectId},'signal-stream');const db=getFirestore(app);
  const runnerId='runner-fixture';await db.collection('runners').doc(runnerId).set({workspaceId:'ws-fixture',deviceSecretHash:'device-hash'});
  const remote=async()=>{
    const claims=await runnerSubscriptionSession(db,runnerId,'device-hash');
    return {version:1,runnerId,workspaceId:claims.workspaceId,firebase:{projectId,apiKey:'local-api-key'},customToken:await getAuth(app).createCustomToken(`runner-device:${runnerId}`,claims)};
  };
  const root=process.env.PULSE_RUNNER_SOURCE || resolve(process.cwd(),'../../pulse-runner');
  const {subscribeRunner}=await importModule(pathToFileURL(join(root,'src/signals.js')).href);
  const config={runnerId,workspaceId:'ws-fixture',endpoint:'http://127.0.0.1:5001/demo-pulse-local/us-east4'};
  const seen:any[]=[];let failed=false;let close:any;
  const until=async(predicate:()=>boolean)=>{const limit=Date.now()+8000;while(!predicate() && Date.now()<limit)await new Promise(r=>setTimeout(r,20));assert.ok(predicate(),'signal was not delivered');};
  try {
    await signalRunner(db,runnerId,'jobs'); // Exists before connecting: no missed wakeup.
    close=await subscribeRunner(config,remote,(v:any)=>seen.push(v),()=>{failed=true;});
    await until(()=>seen.some(v=>v.jobs===1));assert.equal(failed,false);
    await close();close=null;
    await signalRunner(db,runnerId,'profiles');
    close=await subscribeRunner(config,remote,(v:any)=>seen.push(v),()=>{failed=true;});
    await until(()=>seen.some(v=>v.profiles===1));assert.equal(failed,false);
    await db.collection('runners').doc(runnerId).update({revokedAt:'now'});
    await signalRunner(db,runnerId,'jobs');await until(()=>failed);
    await assert.rejects(remote());
  } finally {await close?.();await env.cleanup();await deleteApp(app);}
});
