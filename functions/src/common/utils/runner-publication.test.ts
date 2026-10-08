import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'crypto';
import {parsePublication, validBranch} from './runner-publication';
import {signRunnerJob, runnerJobPayload} from './runner-jobs';
import {parseRunnerReadiness} from './runner-preflight';
const target={repo:'owner/repo',branch:'pul/rjob-test',base:'main',appId:'1',installationId:'2',slug:'local-app',sha:'a'.repeat(40)};
const job:any={id:'rjob-test',protocolVersion:3,projectId:'project-1',publicationTargets:[target],recoveryOf:'rjob-original',workspaceId:'ws',issueId:'issue',agentId:'agent',runnerId:'runner',repoFullName:target.repo,mode:'task',issuedAt:'2026-10-08T00:00:00Z',expiresAt:'2026-10-08T01:00:00Z',signatureAlgorithm:'ed25519',signingKeyId:'test'};
test('v3 signs App identity, repository/ref/base/SHA and recovery id',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const signature=signRunnerJob(job,privateKey.export({type:'pkcs8',format:'pem'}).toString());
  assert(verify(null,Buffer.from(runnerJobPayload(job)),publicKey,Buffer.from(signature,'base64url')));
  for(const field of ['repo','branch','base','appId','installationId','slug','sha']) assert(!verify(null,Buffer.from(runnerJobPayload({...job,publicationTargets:[{...target,[field]:'other'}]})),publicKey,Buffer.from(signature,'base64url')));
  assert(!verify(null,Buffer.from(runnerJobPayload({...job,recoveryOf:'rjob-other'})),publicKey,Buffer.from(signature,'base64url')));
});
test('publication report strips credentials and rejects scope widening, commit substitution and bad PRs',()=>{
  const entry={...target,stage:'linked',prNumber:1,prUrl:'https://github.com/owner/repo/pull/1',token:'secret',path:'/secret'};
  const report=parsePublication({execution:'completed',repositories:[entry],token:'secret'},job);
  assert(!JSON.stringify(report).includes('secret'));
  for(const mutation of [{repo:'other/repo'},{branch:'main'},{sha:'b'.repeat(40)},{prUrl:'https://evil.test'},{prNumber:-1},{stage:'other'}]) assert.throws(()=>parsePublication({execution:'completed',repositories:[{...entry,...mutation}]},job));
  assert.throws(()=>parsePublication({execution:'completed',repositories:[entry,entry]},job));
  for(const branch of ['main..other','pul/../../evil','pul/.hidden','pul/x.lock','pul/space here']) assert(!validBranch(branch));
});
test('local App readiness persists only public identity/capabilities',()=>{
  const report=parseRunnerReadiness({workspaceId:'ws',identities:[],providers:{codex:{cli:true,session:true},claude:{cli:false,session:false}},repositories:[],jobProtocolVersion:3,githubApps:[{...target,projectId:'project-1',ready:true,token:'secret',privateKey:'secret'}]});
  assert.equal(report.jobProtocolVersion,3);assert(!JSON.stringify(report).includes('secret'));
  assert.throws(()=>parseRunnerReadiness({...report,githubApps:[...report.githubApps!,...report.githubApps!]}));
});
