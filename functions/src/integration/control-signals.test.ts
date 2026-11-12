import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runnerSubscriptionSession, signalRunner } from '../runners/signals';
import { runnerJobSignals } from '../triggers/control-signals';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator required');
if (!getApps().length) initializeApp({projectId:'demo-pulse-local'});
const db=getFirestore();
test('session creation is stable, paired rotation invalidates prior generation, revocation rejects', async()=>{
  const id=`runner-signal-${Date.now()}`;const ref=db.collection('runners').doc(id);
  await ref.set({workspaceId:'ws-one',deviceSecretHash:'one'});
  const one=await runnerSubscriptionSession(db,id,'one');
  assert.deepEqual(await runnerSubscriptionSession(db,id,'one'),one);
  assert.equal((await db.collection('runner_signals').doc(id).get()).exists,true);
  await ref.update({deviceSecretHash:'two'});
  await assert.rejects(runnerSubscriptionSession(db,id,'one'));
  const two=await runnerSubscriptionSession(db,id,'two'); assert.notEqual(two.runnerSession,one.runnerSession);
  await ref.update({revokedAt:'now'});await assert.rejects(runnerSubscriptionSession(db,id,'two'));
});
test('durable counters survive duplicate/out-of-order events and never carry a job payload',async()=>{
  const runnerId=`runner-event-${Date.now()}`,issueId=`issue-event-${Date.now()}`;
  const job={runnerId,issueId,status:'pending',secret:'must not leave job'};
  await runnerJobSignals(undefined,job); await runnerJobSignals(undefined,job);
  await runnerJobSignals(job,{...job,status:'delivered'});
  const signal=(await db.collection('runner_signals').doc(runnerId).get()).data()!;
  assert.equal(signal.jobs,2);assert.deepEqual(Object.keys(signal),['jobs']);
  await signalRunner(db,runnerId,'profiles');
  assert.equal((await db.collection('runner_signals').doc(runnerId).get()).data()!.profiles,1);
  assert.ok((await db.collection('issue_signals').doc(issueId).get()).data()!.revision>=2);
});

test('device sessions cannot invoke browser actions or telemetry', async()=>{
  const {pulsePlatformAction,pulseClientTelemetry}=await import('../index');
  for (const token of [{runnerDevice:true},{}]) {
    const req:any={auth:{uid:'runner-device:fixture',token},data:{}};
    await assert.rejects(async()=>pulsePlatformAction.run(req),(e:any)=>e.code==='permission-denied');
    await assert.rejects(async()=>pulseClientTelemetry.run(req),(e:any)=>e.code==='unauthenticated');
  }
});
