import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { CancelRunnerJobAction } from '../actions/runners/cancel-runner-job';
import { configureRunnerRepos } from '../runners/configure-repos';
import { pulseRunnerHeartbeat, pulseRunnerConfigure, pulseRunnerComplete } from '../runners/endpoint';
import { hashApiKeySecret } from '../common/utils/api-key';
import { recordRunnerCompletion } from '../runners/record-completion';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator is required.');
if (!getApps().length) initializeApp({projectId:'pulse-integration'});
process.env.MCP_KEY_PEPPER = 'synthetic-test-pepper';
const db = getFirestore();
async function seed(status = 'delivered') {
  const suffix = randomBytes(6).toString('hex');
  const workspaceId = `ws-cancel-${suffix}`;
  const runnerId = `runner-${suffix}`;
  const jobId = `rjob-${suffix}`;
  const owner = `owner-${suffix}`;
  const admin = `admin-${suffix}`;
  const other = `other-${suffix}`;
  const outsider = `outsider-${suffix}`;
  const secret = 'synthetic-device-secret-12345678901234567890';
  const job = { id:jobId, workspaceId, runnerId, agentId:`agent-${suffix}`, issueId:`issue-${suffix}`, status, expiresAt:'2099-01-01T00:00:00.000Z', mode:'task' };
  await Promise.all([
    db.collection('members').doc(`${workspaceId}_${owner}`).set({workspaceId,userId:owner,role:'member'}),
    db.collection('members').doc(`${workspaceId}_${admin}`).set({workspaceId,userId:admin,role:'admin'}),
    db.collection('members').doc(`${workspaceId}_${other}`).set({workspaceId,userId:other,role:'member'}),
    db.collection('members').doc(`other_${outsider}`).set({workspaceId:'other',userId:outsider,role:'admin'}),
    db.collection('runners').doc(runnerId).set({id:runnerId,workspaceId,ownerMemberId:owner,status:'busy',connectedRepos:['owner/repo','owner/app'],deviceSecretHash:hashApiKeySecret(secret,process.env.MCP_KEY_PEPPER!)}),
    db.collection('runner_jobs').doc(jobId).set(job),
    db.collection('agent_runs').doc(jobId).set({...job,startedAt:new Date().toISOString()}),
    db.collection('api_keys').doc(`key-${suffix}`).set({workspaceId,jobId,revokedAt:null}),
    db.collection('agents').doc(job.agentId).set({id:job.agentId,workspaceId,kind:'codex'}),
  ]);
  return {job,jobId,runnerId,owner,admin,other,outsider,workspaceId,keyId:`key-${suffix}`,credential:`${runnerId}.${secret}`};
}
async function endpoint(fn: typeof pulseRunnerHeartbeat, credential: string, body: any) {
  let code=200; let response:any;
  const req:any={method:'POST',headers:{authorization:`Bearer ${credential}`},body};
  const res:any=new EventEmitter();
  const headers:Record<string,unknown>={};
  res.setHeader=(name:string,value:unknown)=>{headers[name.toLowerCase()]=value;};
  res.getHeader=(name:string)=>headers[name.toLowerCase()];
  res.status=(value:number)=>{code=value;return res;};
  res.json=res.send=(value:any)=>{response=value;res.emit('finish');};
  await fn(req,res);
  return {code,body:response};
}
const cancel=(jobId:string,caller:string)=>new CancelRunnerJobAction({actionCode:'runners.cancelJob',data:{jobId}},caller).run();

test('cancel: owner/admin may cancel; members and external admins may not',async()=>{
  const f=await seed();
  for(const caller of [f.other,f.outsider]) assert.equal((await cancel(f.jobId,caller)).success,false);
  assert.equal((await db.collection('runner_jobs').doc(f.jobId).get()).data()!.cancelRequestedAt,undefined);
  assert.equal((await cancel(f.jobId,f.owner)).success,true);
  const admin=await seed(); assert.equal((await cancel(admin.jobId,admin.admin)).success,true);
});

test('cancel: pending jobs finish immediately and revoke ephemeral MCP access',async()=>{
  const f=await seed('pending');
  assert.equal((await cancel(f.jobId,f.owner)).success,true);
  assert.equal((await db.collection('runner_jobs').doc(f.jobId).get()).data()!.status,'canceled');
  assert.equal((await db.collection('agent_runs').doc(f.jobId).get()).data()!.runnerOutcome,'canceled');
  assert.ok((await db.collection('api_keys').doc(f.keyId).get()).data()!.revokedAt);
});

test('cancel: delivered jobs retain capacity until acknowledged; heartbeat carries scoped cancellation',async()=>{
  const f=await seed();
  assert.equal((await endpoint(pulseRunnerHeartbeat,f.credential,{status:'busy',jobId:f.jobId})).body.cancelRequested,false);
  await cancel(f.jobId,f.owner);
  const requested=(await db.collection('runner_jobs').doc(f.jobId).get()).data()!;
  assert.equal(requested.status,'delivered');
  assert.ok(requested.cancelRequestedAt);
  assert.equal(requested.completedAt,undefined);
  assert.ok((await db.collection('api_keys').doc(f.keyId).get()).data()!.revokedAt);
  const heartbeat=await endpoint(pulseRunnerHeartbeat,f.credential,{status:'busy',jobId:f.jobId});
  assert.equal(heartbeat.code,200); assert.equal(heartbeat.body.cancelRequested,true);
  const foreign=await seed();
  assert.equal((await endpoint(pulseRunnerHeartbeat,f.credential,{status:'busy',jobId:foreign.jobId})).code,404);
  const completed=await endpoint(pulseRunnerComplete,f.credential,{jobId:f.jobId,outcome:'canceled',result:'Stopped locally.'});
  assert.equal(completed.code,200); assert.equal(completed.body.status,'canceled');
  assert.equal((await db.collection('agent_runs').doc(f.jobId).get()).data()!.runnerOutcome,'canceled');
});

test('cancel: completion racing a cancellation cannot overwrite it with success',async()=>{
  const f=await seed(); await cancel(f.jobId,f.owner);
  const completed=await endpoint(pulseRunnerComplete,f.credential,{jobId:f.jobId,outcome:'completed'});
  assert.equal(completed.body.status,'canceled');
  assert.equal((await db.collection('runner_jobs').doc(f.jobId).get()).data()!.status,'canceled');
  const duplicate=await recordRunnerCompletion(db,f.jobId,f.runnerId,'codex','completed',{usage:null},new Date().toISOString());
  assert.equal(duplicate,'canceled');
});

test('cancel: requests are idempotent and cannot change terminal jobs',async()=>{
  const f=await seed(); await cancel(f.jobId,f.owner);
  const first=(await db.collection('runner_jobs').doc(f.jobId).get()).data()!;
  await cancel(f.jobId,f.admin);
  const second=(await db.collection('runner_jobs').doc(f.jobId).get()).data()!;
  assert.equal(second.cancelRequestedAt,first.cancelRequestedAt);
  assert.equal(second.cancelRequestedBy,f.owner);
  for(const status of ['completed','failed','canceled','expired']) {
    const terminal=await seed(status); await cancel(terminal.jobId,terminal.owner);
    const data=(await db.collection('runner_jobs').doc(terminal.jobId).get()).data()!;
    assert.equal(data.status,status); assert.equal(data.cancelRequestedAt,undefined);
  }
});

test('configure: the actual endpoint rejects widening and allows narrowing or unchanged scope',async()=>{
  const f=await seed();
  assert.equal((await endpoint(pulseRunnerConfigure,f.credential,{connectedRepos:'invalid'})).code,400);
  assert.equal((await endpoint(pulseRunnerConfigure,f.credential,{connectedRepos:['owner/other']})).code,403);
  assert.deepEqual((await db.collection('runners').doc(f.runnerId).get()).data()!.connectedRepos,['owner/repo','owner/app']);
  const reduced=await endpoint(pulseRunnerConfigure,f.credential,{connectedRepos:['owner/repo']});
  assert.equal(reduced.code,200); assert.deepEqual(reduced.body.connectedRepos,['owner/repo']);
  assert.deepEqual(await configureRunnerRepos(db,f.runnerId,['owner/repo','owner/repo']),['owner/repo']);
  await assert.rejects(configureRunnerRepos(db,f.runnerId,['owner/app']));
  await db.collection('runners').doc(f.runnerId).update({revokedAt:new Date().toISOString()});
  assert.equal((await endpoint(pulseRunnerConfigure,f.credential,{connectedRepos:[]})).code,401);
  assert.equal((await endpoint(pulseRunnerHeartbeat,f.credential,{status:'busy',jobId:f.jobId})).code,401);
});


test('cancel: a queued QA job reports its review incomplete instead of leaving it running',async()=>{
  const f=await seed('pending');
  await db.collection('runner_jobs').doc(f.jobId).update({mode:'review'});
  await db.collection('members').doc(`${f.workspaceId}_${f.job.agentId}`).set({workspaceId:f.workspaceId,userId:f.job.agentId,role:'member',isAgent:true});
  await db.collection('issues').doc(f.job.issueId).set({
    id:f.job.issueId,workspaceId:f.workspaceId,teamId:'team-test',identifier:'INT-QA',creatorId:f.owner,labelIds:[],
    review:{state:'running',dispatchedTo:f.job.agentId,attempt:1},
  });
  const result=await cancel(f.jobId,f.owner);
  assert.equal(result.success,true);
  assert.equal((await db.collection('issues').doc(f.job.issueId).get()).data()!.review.state,'needs_human');
});

test('runner QA completion closes an unclaimed attempt without blocking shadow development',async()=>{
  for (const review of [
    {dispatchedTo:'agent',attempt:1},
    {state:'running',dispatchedTo:'agent',claimedBy:'agent',attempt:1},
  ]) {
    const f=await seed();
    await db.collection('runner_jobs').doc(f.jobId).update({mode:'review'});
    await db.collection('agents').doc(f.job.agentId).update({role:'qa',qaMode:'shadow'});
    await db.collection('members').doc(`${f.workspaceId}_${f.job.agentId}`).set({workspaceId:f.workspaceId,userId:f.job.agentId,role:'member',isAgent:true});
    const assignedReview={...review,dispatchedTo:f.job.agentId,...(review.state==='running'?{claimedBy:f.job.agentId}:{})};
    await db.collection('issues').doc(f.job.issueId).set({
      id:f.job.issueId,workspaceId:f.workspaceId,teamId:'team-test',identifier:'INT-QA-SHADOW',creatorId:f.owner,
      status:'in_review',assigneeId:f.owner,labelIds:['feature'],review:assignedReview,
    });

    const result=await endpoint(pulseRunnerComplete,f.credential,{jobId:f.jobId,outcome:'completed'});
    assert.equal(result.body.status,'completed');
    const issue=(await db.collection('issues').doc(f.job.issueId).get()).data()!;
    assert.equal(issue.review.state,'needs_human');
    assert.equal(issue.status,'in_review');
    assert.equal(issue.assigneeId,f.owner);
    assert.deepEqual(issue.labelIds,['feature']);
    const comments=await db.collection('comments').where('issueId','==',f.job.issueId).get();
    assert.equal(comments.size,1);
    assert.match(comments.docs[0].data().body,/modo shadow mantiene intactos/);
  }
});

test('runner QA completion leaves an already-submitted verdict unchanged',async()=>{
  const f=await seed();
  await db.collection('runner_jobs').doc(f.jobId).update({mode:'review'});
  await db.collection('agents').doc(f.job.agentId).update({role:'qa',qaMode:'shadow'});
  await db.collection('issues').doc(f.job.issueId).set({
    id:f.job.issueId,workspaceId:f.workspaceId,teamId:'team-test',identifier:'INT-QA-VERDICT',creatorId:f.owner,
    status:'in_review',review:{state:'approved',dispatchedTo:f.job.agentId,attempt:1},
  });

  const result=await endpoint(pulseRunnerComplete,f.credential,{jobId:f.jobId,outcome:'completed'});
  assert.equal(result.body.status,'completed');
  assert.equal((await db.collection('issues').doc(f.job.issueId).get()).data()!.review.state,'approved');
  assert.equal((await db.collection('comments').where('issueId','==',f.job.issueId).get()).size,0);
});
