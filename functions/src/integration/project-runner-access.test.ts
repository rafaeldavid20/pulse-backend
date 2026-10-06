import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { runnerProjectRepoAccess, runnerProjectAccessForDispatch } from '../common/utils/project-repos';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { hashApiKeySecret } from '../common/utils/api-key';
import { pulseRunnerPoll } from '../runners/endpoint';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
process.env.MCP_KEY_PEPPER = 'synthetic-test-pepper';
const db = getFirestore();
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
async function fixture(protocolVersion?: 2) {
  const suffix = randomBytes(6).toString('hex');
  const workspaceId = `ws-project-${suffix}`, projectId = `project-${suffix}`, issueId = `issue-${suffix}`, runnerId = `runner-${suffix}`, agentId = `agent-${suffix}`;
  const secret = 'synthetic-device-secret-12345678901234567890';
  const readiness = { workspaceId, identities: [{ agentId, kind: 'codex', role: 'dev' }], providers: { codex: { cli: true, session: true } }, repositories: [{ repo: 'owner/repo', accessible: true }], ...(protocolVersion ? {jobProtocolVersion:protocolVersion} : {}) };
  await Promise.all([
    db.collection('issues').doc(issueId).set({ workspaceId, projectId }),
    db.collection('projects').doc(projectId).set({ workspaceId, repoFullNames: ['owner/repo'] }),
    db.collection('github_installations').doc(workspaceId).set({ workspaceId, repositoryFullNames: ['owner/repo'] }),
    db.collection('agents').doc(agentId).set({ id:agentId, workspaceId, runnerId, enabled:true, kind:'codex',role:'dev',allowedRepos:protocolVersion ? [] : ['owner/repo'] }),
    db.collection('runners').doc(runnerId).set({ id:runnerId,workspaceId,ownerMemberId:'test-owner',status:'online',lastHeartbeatAt:new Date().toISOString(),readinessCheckedAt:new Date().toISOString(),readiness,connectedRepos:protocolVersion ? [] : ['owner/repo'],deviceSecretHash:hashApiKeySecret(secret,process.env.MCP_KEY_PEPPER!) }),
  ]);
  const job = { id:`rjob-${suffix}`,workspaceId,issueId,agentId,runnerId,repoFullName:'owner/repo',contextRepos:['owner/repo'],mode:'task' as const,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),status:'pending',...(protocolVersion ? {protocolVersion,projectId} : {}) };
  return {workspaceId,projectId,issueId,runnerId,agentId,job,credential:`${runnerId}.${secret}`};
}
async function poll(credential:string) {
  let code = 200, body:any;
  const req:any={method:'POST',headers:{authorization:`Bearer ${credential}`},body:{}};
  const res:any=new EventEmitter();
  res.setHeader=()=>{};res.getHeader=()=>undefined;res.status=(value:number)=>{code=value;return res;};res.json=res.send=(value:any)=>{body=value;res.emit('finish');};
  await pulseRunnerPoll(req,res);
  return {code,body};
}
test('project boundary rejects missing, foreign, empty and uninstalled repository configurations',async()=>{
  const f=await fixture(2);
  const issue={workspaceId:f.workspaceId,projectId:f.projectId};
  assert.deepEqual(await runnerProjectRepoAccess(db,issue,['owner/repo']),{projectId:f.projectId,repos:['owner/repo']});
  assert.equal(await runnerProjectRepoAccess(db,{workspaceId:f.workspaceId},['owner/repo']),null);
  assert.equal(await runnerProjectRepoAccess(db,{...issue,projectId:'missing-project'},['owner/repo']),null);
  await db.collection('projects').doc(f.projectId).update({workspaceId:'foreign'});
  assert.equal(await runnerProjectRepoAccess(db,issue,['owner/repo']),null);
  await db.collection('projects').doc(f.projectId).update({workspaceId:f.workspaceId,repoFullNames:[]});
  assert.equal(await runnerProjectRepoAccess(db,issue,['owner/repo']),null);
  await db.collection('projects').doc(f.projectId).update({repoFullNames:['owner/repo']});
  assert.deepEqual((await runnerProjectRepoAccess(db,issue,['owner/other']))?.repos,[]);
});
test('new enqueue is project scoped without agent/Runner allowlists; old Runner gets an actionable upgrade gate',async()=>{
  const f=await fixture(2);
  const input={workspaceId:f.workspaceId,issueId:f.issueId,agentId:f.agentId,runnerId:f.runnerId,repoFullName:'owner/repo',mode:'task' as const};
  const job=await enqueueRunnerJob(db,input,privateKey);
  assert.equal(job.projectId,f.projectId);assert.equal(job.protocolVersion,2);assert.equal(job.signingKeyId,'runner-job-v1');
  const old=await fixture();
  await assert.rejects(enqueueRunnerJob(db,{...input,workspaceId:old.workspaceId,issueId:old.issueId,agentId:old.agentId,runnerId:old.runnerId},privateKey),/npm install -g @pulsehub\/runner@latest/);
  assert.equal((await db.collection('runner_jobs').where('runnerId','==',old.runnerId).get()).size,0);
});
for(const version of [undefined,2] as const) {
  test(`poll delivers unchanged legacy/v2 envelopes (${version||1}) without rewriting their signature`,async()=>{
    const f=await fixture(version);await db.collection('runner_jobs').doc(f.job.id).set({...f.job,signature:'unchanged-signature'});
    const result=await poll(f.credential);
    assert.equal(result.code,200);assert.equal(result.body.job.id,f.job.id);assert.equal(result.body.job.signature,'unchanged-signature');
    assert.equal(result.body.job.projectId,version ? f.projectId : undefined);
    assert.equal((await db.collection('api_keys').where('jobId','==',f.job.id).get()).size,1);
  });
  for(const change of ['project-removal','installation-removal','workspace','issue-project','agent-binding','empty-project']) {
    test(`poll cancels ${version||1} job after ${change}, without issuing an MCP key`,async()=>{
      const f=await fixture(version);await db.collection('runner_jobs').doc(f.job.id).set(f.job);
      if(change==='project-removal'||change==='empty-project') await db.collection('projects').doc(f.projectId).update({repoFullNames:change==='empty-project'?[]:['owner/other']});
      if(change==='installation-removal') await db.collection('github_installations').doc(f.workspaceId).update({repositoryFullNames:[]});
      if(change==='workspace') await db.collection('projects').doc(f.projectId).update({workspaceId:'foreign'});
      if(change==='issue-project') await db.collection('issues').doc(f.issueId).update({projectId:'missing-project'});
      if(change==='agent-binding') await db.collection('agents').doc(f.agentId).update({runnerId:'other-runner'});
      assert.equal((await poll(f.credential)).body.job,null);
      assert.equal((await db.collection('runner_jobs').doc(f.job.id).get()).data()!.status,'canceled');
      assert.equal((await db.collection('api_keys').where('jobId','==',f.job.id).get()).size,0);
    });
  }
}

test('legacy project dispatch leaves an actionable visible issue diagnostic', async () => {
  const f = await fixture(2);
  await db.collection('projects').doc(f.projectId).update({ repoFullNames: [] });
  assert.equal(await runnerProjectAccessForDispatch(db, { id: f.issueId, workspaceId: f.workspaceId, projectId: f.projectId }, ['owner/repo'], 'owner/repo'), null);
  const issue = (await db.collection('issues').doc(f.issueId).get()).data()!;
  assert.equal(issue.agent.state, 'blocked');
  assert.match(issue.agent.blockedReason, /Configurá repositorios en el proyecto/);
});
