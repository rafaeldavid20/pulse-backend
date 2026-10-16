import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ListRunnersAction } from '../actions/runners/manage-runners';
import { pulseRunnerHeartbeat } from '../runners/endpoint';
import { hashApiKeySecret } from '../common/utils/api-key';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required');
if (!getApps().length) initializeApp({projectId:'demo-pulse-local'});
process.env.MCP_KEY_PEPPER='synthetic-version-test-pepper';
const db=getFirestore();

async function heartbeat(id: string, body: any) {
  const res: any=new EventEmitter(); let code=200; let result: any;
  res.setHeader=()=>{}; res.getHeader=()=>undefined;
  res.status=(value: number)=>{code=value;return res;};
  res.json=res.send=(value: any)=>{result=value;res.emit('finish');};
  await pulseRunnerHeartbeat({method:'POST',headers:{authorization:`Bearer ${id}.synthetic-device-secret-12345678901234567890`},body} as any,res);
  assert.equal(code,200);
  return result;
}

test('heartbeat version replacement and multiple Runners preserve owner/admin and workspace isolation',async()=>{
  const suffix=randomBytes(6).toString('hex');
  const ws=`ws-version-${suffix}`, otherWs=`ws-other-${suffix}`;
  const owner=`owner-${suffix}`, admin=`admin-${suffix}`, other=`other-${suffix}`;
  const one=`runner-${randomBytes(6).toString('hex')}`, two=`runner-${randomBytes(6).toString('hex')}`, external=`runner-${randomBytes(6).toString('hex')}`;
  await Promise.all([
    ...[[owner,'member',ws],[admin,'admin',ws],[other,'member',ws],[admin,'admin',otherWs]].map(([userId,role,workspaceId])=>db.collection('members').doc(`${workspaceId}_${userId}`).set({userId,role,workspaceId})),
    ...[[one,owner,ws],[two,other,ws],[external,owner,otherWs]].map(([id,ownerMemberId,workspaceId])=>db.collection('runners').doc(id).set({id,ownerMemberId,workspaceId,status:'offline',deviceSecretHash:hashApiKeySecret('synthetic-device-secret-12345678901234567890',process.env.MCP_KEY_PEPPER!)})),
    db.collection('public_package_cache').doc('pulse-runner-latest').set({leaseUntil:0,release:{status:'available',version:'0.1.19',checkedAt:new Date().toISOString(),nextCheckAt:Date.now()+900000}}),
  ]);
  const list=async(uid: string)=>new ListRunnersAction({actionCode:'runners.list',data:{workspaceId:ws}},uid).run();
  await heartbeat(one,{status:'online',processVersion:'0.1.17'});
  await heartbeat(two,{status:'online',processVersion:'0.1.20-dev.1',capabilities:{usageReport:true,privatePath:'private'}});
  const own=await list(owner); assert.equal(own.success,true);
  const ownRows=own.data!.runners;
  assert.equal(ownRows.length,1);assert.equal(ownRows[0].updateStatus,'update_available');
  assert.equal(ownRows[0].processVersion,'0.1.17');assert.ok(ownRows[0].versionReportedAt);
  const all=await list(admin);assert.equal(all.data!.runners.length,2);
  assert.equal(all.data!.runners.find((r:any)=>r.id===two).updateStatus,'current');
  assert.equal(JSON.stringify(all.data).includes('deviceSecretHash'),false);
  assert.equal(JSON.stringify(all.data).includes('privatePath'),false);
  await db.collection('runners').doc(one).update({status:'offline'});
  assert.equal((await list(owner)).data!.runners[0].processVersion,'0.1.17');
  await heartbeat(one,{status:'online',processVersion:'0.1.19',capabilities:{usageReport:true}});
  assert.equal((await list(owner)).data!.runners[0].updateStatus,'current');
  await heartbeat(one,{status:'online'});
  assert.equal((await list(owner)).data!.runners[0].updateStatus,'unknown');
  assert.equal((await list('outsider')).success,false);
});
