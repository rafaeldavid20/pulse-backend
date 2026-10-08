import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'events';
import {generateKeyPairSync,randomBytes} from 'crypto';
import {initializeApp,getApps} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {enqueueRunnerJob} from '../common/utils/runner-jobs';
import {hashApiKeySecret} from '../common/utils/api-key';
import {pulseRunnerPublication,pulseRunnerLinkPr} from '../runners/endpoint';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
if (!getApps().length) initializeApp({projectId:'pulse-integration'});
process.env.MCP_KEY_PEPPER='synthetic-test-pepper';
const db=getFirestore();
const key=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
async function fixture() {
  const suffix=randomBytes(6).toString('hex'), workspaceId=`ws-${suffix}`,projectId=`project-${suffix}`,issueId=`issue-${suffix}`,agentId=`agent-${suffix}`,runnerId=`runner-${suffix}`;
  const repos=['owner/repo','owner/app'];
  const githubApps=repos.map(repo=>({projectId,repo,appId:'1',installationId:'2',slug:'local-app',base:'main',ready:true}));
  const secret='synthetic-device-secret-12345678901234567890';
  const readiness={workspaceId,identities:[{agentId,kind:'codex',role:'dev'}],providers:{codex:{cli:true,session:true},claude:{cli:false,session:false}},repositories:[],jobProtocolVersion:3,githubApps};
  await Promise.all([
    db.collection('issues').doc(issueId).set({workspaceId,projectId}),
    db.collection('projects').doc(projectId).set({workspaceId,repoFullNames:repos}),
    db.collection('github_installations').doc(workspaceId).set({workspaceId,repositoryFullNames:repos}),
    db.collection('agents').doc(agentId).set({id:agentId,workspaceId,runnerId,enabled:true,kind:'codex',role:'dev',ownerMemberId:'owner',visibility:'personal'}),
    db.collection('runners').doc(runnerId).set({id:runnerId,workspaceId,ownerMemberId:'owner',status:'online',lastHeartbeatAt:new Date().toISOString(),readinessCheckedAt:new Date().toISOString(),readiness,deviceSecretHash:hashApiKeySecret(secret,process.env.MCP_KEY_PEPPER!)}),
  ]);
  const input={workspaceId,projectId,issueId,agentId,runnerId,repoFullName:repos[0],contextRepos:repos,mode:'task' as const};
  const job=await enqueueRunnerJob(db,input,key);
  await db.collection('runner_jobs').doc(job.id).update({status:'delivered'});
  const report={execution:'completed',repositories:job.publicationTargets!.map(t=>({repo:t.repo,branch:t.branch,sha:'a'.repeat(40),stage:'pending'}))};
  return {input,job,report,credential:`${runnerId}.${secret}`,readiness};
}
async function call(endpoint:any, credential:string, data:any) {
  let code=200,body:any;const req:any={method:'POST',headers:{authorization:`Bearer ${credential}`},body:data};const res:any=new EventEmitter();
  res.setHeader=()=>{};res.getHeader=()=>undefined;res.status=(value:number)=>{code=value;return res;};res.json=res.send=(value:any)=>{body=value;res.emit('finish');};
  await endpoint(req,res);return {code,body};
}
test('checkpoint stores only public metadata and links every PR idempotently',async()=>{
  const f=await fixture();assert.equal(f.job.protocolVersion,3);
  const body={jobId:f.job.id,publication:{...f.report,token:'sentinel-secret',repositories:f.report.repositories.map(e=>({...e,privateKey:'sentinel-secret'}))}};
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,200);
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,200);
  const saved=(await db.collection('runner_jobs').doc(f.job.id).get()).data()!;
  assert(!JSON.stringify(saved).includes('sentinel-secret'));
  for(const e of f.report.repositories) {
    const pr={jobId:f.job.id,...e,prNumber:42,prUrl:`https://github.com/${e.repo}/pull/42`};
    assert.equal((await call(pulseRunnerLinkPr,f.credential,pr)).code,200);
    assert.equal((await call(pulseRunnerLinkPr,f.credential,pr)).code,200);
  }
  const issue=(await db.collection('issues').doc(f.input.issueId).get()).data()!;
  assert.equal(issue.gitRefs.length,2);assert.deepEqual(issue.gitRefs.map((e:any)=>e.repoFullName).sort(),['owner/app','owner/repo']);
  assert.equal((await call(pulseRunnerLinkPr,f.credential,{jobId:f.job.id,...f.report.repositories[0],branch:'main',prNumber:42,prUrl:'https://github.com/owner/repo/pull/42'})).code,409);
});
test('project removal, revocation, expiry and changed commit fail closed',async()=>{
  const f=await fixture();const body={jobId:f.job.id,publication:f.report};
  assert.equal((await call(pulseRunnerPublication,'runner-invalid.invalid',body)).code,401);
  await db.collection('projects').doc(f.input.projectId).update({repoFullNames:['owner/repo']});
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,409);
  await db.collection('projects').doc(f.input.projectId).update({repoFullNames:f.input.contextRepos});
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,200);
  assert.equal((await call(pulseRunnerPublication,f.credential,{...body,publication:{...f.report,repositories:f.report.repositories.map(e=>({...e,sha:'b'.repeat(40)}))}})).code,409);
  await db.collection('runner_jobs').doc(f.job.id).update({expiresAt:'2000-01-01T00:00:00Z'});
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,409);
  await db.collection('runners').doc(f.input.runnerId).update({revokedAt:new Date().toISOString()});
  assert.equal((await call(pulseRunnerPublication,f.credential,body)).code,401);
});
test('publication retry signs same repos/refs/SHAs and only one concurrent request wins',async()=>{
  const f=await fixture();await call(pulseRunnerPublication,f.credential,{jobId:f.job.id,publication:f.report});
  await db.collection('runner_jobs').doc(f.job.id).update({status:'failed'});
  await db.collection('runners').doc(f.input.runnerId).update({'readiness.providers.codex.session':false});
  const targets=f.job.publicationTargets!.map(t=>({...t,sha:'a'.repeat(40)}));
  await assert.rejects(enqueueRunnerJob(db,{...f.input,recoveryOf:f.job.id,publicationTargets:targets.map(t=>({...t,sha:'b'.repeat(40)}))},key));
  const results=await Promise.allSettled([1,2].map(()=>enqueueRunnerJob(db,{...f.input,recoveryOf:f.job.id,publicationTargets:targets},key)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const retry=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
  assert.equal(retry.recoveryOf,f.job.id);assert.deepEqual(retry.publicationTargets,targets);
  assert((await db.collection('agent_runs').doc(retry.id).get()).data()?.publicationOnly);
  assert.equal((await db.collection('runner_jobs').doc(f.job.id).get()).data()?.retriedByJobId,retry.id);
});


test('service App also stops persisting installation tokens and clears its legacy cache on use',async()=>{
  const id=`cache-${randomBytes(6).toString('hex')}`;
  const originalFetch=global.fetch;
  const oldId=process.env.GITHUB_APP_ID,oldKey=process.env.GITHUB_APP_PRIVATE_KEY_B64;
  process.env.GITHUB_APP_ID='1';
  process.env.GITHUB_APP_PRIVATE_KEY_B64=Buffer.from(generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()).toString('base64');
  try {
    await db.collection('github_installations').doc(id).set({workspaceId:'test',tokenCache:{token:'legacy-sentinel',expiresAt:new Date(Date.now()+3600000).toISOString()}});
    let calls=0;global.fetch=(async()=>{calls++;return {ok:true,json:async()=>({token:'fresh-sentinel',expires_at:new Date(Date.now()+3600000).toISOString()})};}) as any;
    const {getInstallationToken}=await import('../github/app-auth');
    assert.equal(await getInstallationToken(id),'fresh-sentinel');assert.equal(await getInstallationToken(id),'fresh-sentinel');assert.equal(calls,1);
    const data=(await db.collection('github_installations').doc(id).get()).data();assert.equal(data?.tokenCache,undefined);assert(!JSON.stringify(data).includes('sentinel'));
  } finally {global.fetch=originalFetch;if(oldId===undefined)delete process.env.GITHUB_APP_ID;else process.env.GITHUB_APP_ID=oldId;if(oldKey===undefined)delete process.env.GITHUB_APP_PRIVATE_KEY_B64;else process.env.GITHUB_APP_PRIVATE_KEY_B64=oldKey;}
});
