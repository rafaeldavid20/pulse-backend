import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { findPendingRunnerJob } from '../common/utils/pending-runner-job';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator is required');
if (!getApps().length) initializeApp({projectId:'pulse-integration'});
const db=getFirestore();
test('emulator: real query paginates expired pending jobs and preserves all history',async()=>{
 const prefix='poll-'+Date.now(), runnerId=prefix+'-runner';
 const now=Date.now(), batch=db.batch(), ids:string[]=[];
 for(let i=0;i<45;i++) {
  const id=prefix+'-a-'+String(i).padStart(2,'0'); ids.push(id);
  batch.set(db.collection('runner_jobs').doc(id),{id,runnerId,status:i<21?'completed':'pending',issuedAt:new Date(now-5000).toISOString(),expiresAt:new Date(now-1).toISOString()});
 }
 const id=prefix+'-z-valid';ids.push(id);batch.set(db.collection('runner_jobs').doc(id),{id,runnerId,status:'pending',issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60_000).toISOString()});
 const foreign=prefix+'-foreign';ids.push(foreign);batch.set(db.collection('runner_jobs').doc(foreign),{id:foreign,runnerId:'other-'+runnerId,status:'pending',issuedAt:new Date(now-9000).toISOString(),expiresAt:new Date(now+60_000).toISOString()});
 await batch.commit();
 try {
  assert.equal((await findPendingRunnerJob(db,runnerId,now))?.id,id);
  assert.equal((await db.collection('runner_jobs').where('runnerId','==',runnerId).get()).size,46);
 } finally {const cleanup=db.batch(); for(const id of ids) cleanup.delete(db.collection('runner_jobs').doc(id));await cleanup.commit();}
});
