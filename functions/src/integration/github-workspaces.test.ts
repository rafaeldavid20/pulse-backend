import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'crypto';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { reusableConnections, saveWorkspaceConnection } from '../github/workspace-connections';
import { refreshInstallationRepos, handleInstallationEvent } from '../github/installation-sync';
import * as client from '../github/client';
import { validateRepoForWorkspace } from '../common/utils/repo-field';
import { runnerProjectRepoAccess } from '../common/utils/project-repos';
import { SyncFromWebhookAction } from '../actions/github/sync-from-webhook';
import { GithubStatusAction } from '../actions/github/github-status';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore emulator required.');
if (!getApps().length) initializeApp({ projectId: 'pulse-integration' });
const db = getFirestore();
async function fixture() {
  const suffix = randomBytes(5).toString('hex');
  const id = String(parseInt(suffix, 16)), uid = `uid-${suffix}`;
  const a = `ws-a-${suffix}`, b = `ws-b-${suffix}`, c = `ws-c-${suffix}`;
  const repos = [`owner/old-${suffix}`, `owner/new-${suffix}`, `owner/free-${suffix}`];
  const details = repos.map((fullName, id) => ({ fullName, id, defaultBranch: 'main' }));
  await Promise.all([
    ...[a,b,c].map(workspaceId => db.collection('members').doc(`${workspaceId}_${uid}`).set({ workspaceId, userId: uid, role: 'owner' })),
    db.collection('github_installations').doc(id).set({ installationId: id, workspaceId: a, accountLogin: 'owner', repositoryFullNames: [repos[0]], repositories: [details[0]], availableRepositories: details, tokenCache: { token: 'synthetic-private-token' } }),
  ]);
  return { id, uid, a, b, c, repos, details };
}

test('reuse preserves legacy workspace, returns safe choices and scopes branch/job authorization', async () => {
  const f = await fixture();
  const choices = await reusableConnections(f.b, f.uid);
  assert.deepEqual(choices[0].assignedElsewhere, [f.repos[0]]);
  assert.ok(!JSON.stringify(choices).includes('synthetic-private-token'));
  await saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]);
  assert.deepEqual((await db.collection('github_installations').doc(f.id).get()).data()!.repositoryFullNames, [f.repos[0]]);
  await validateRepoForWorkspace(db, f.b, f.repos[1]);
  await assert.rejects(validateRepoForWorkspace(db, f.b, f.repos[0]));
  const projectId = `proj-${f.id}`;
  await db.collection('projects').doc(projectId).set({ workspaceId: f.b, repoFullNames: f.repos });
  const grant = (await db.collection('github_installations').doc(`${f.id}_${f.b}`).get()).data()!;
  assert.deepEqual((await runnerProjectRepoAccess(db, { workspaceId: f.b, projectId }, grant.repositoryFullNames))!.repos, [f.repos[1]]);
});

test('target member, unrelated admin and revoked source admin cannot discover or link installation', async () => {
  const f = await fixture();
  await db.collection('members').doc(`${f.b}_${f.uid}`).update({ role: 'member' });
  assert.deepEqual(await reusableConnections(f.b, f.uid), []);
  await assert.rejects(saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]));
  await db.collection('members').doc(`${f.b}_${f.uid}`).update({ role: 'owner' });
  await db.collection('members').doc(`${f.a}_${f.uid}`).delete();
  assert.deepEqual(await reusableConnections(f.b, f.uid), []);
  await assert.rejects(saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]));
});

test('empty selection denies access; invalid or already assigned repo cannot be linked', async () => {
  const f = await fixture();
  await assert.rejects(saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[0]]));
  await assert.rejects(saveWorkspaceConnection(f.b, f.uid, f.id, ['other/private']));
  await saveWorkspaceConnection(f.b, f.uid, f.id, []);
  await assert.rejects(validateRepoForWorkspace(db, f.b, f.repos[1]));
});

test('two concurrent workspaces cannot claim the same repository', async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]), saveWorkspaceConnection(f.c, f.uid, f.id, [f.repos[1]])]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
});

test('removing a repo requires disconnecting its agents and environments first', async () => {
  const f = await fixture();
  await saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]);
  for (const collection of ['agents','environments']) {
    const ref = db.collection(collection).doc(`connected-${f.id}`);
    await ref.set({ workspaceId: f.b, connectedRepos: [{ repoFullName: f.repos[1] }] });
    await assert.rejects(saveWorkspaceConnection(f.b, f.uid, f.id, []), /Desconectá/);
    await ref.delete();
  }
  await saveWorkspaceConnection(f.b, f.uid, f.id, []);
});

test('GitHub additions do not widen grants; removals and suspend apply to all bindings; unsuspend restores only selections', async () => {
  const f = await fixture();
  await saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]);
  let remote = f.details.map(r => ({ id:r.id, full_name:r.fullName, default_branch:r.defaultBranch }));
  const stub = mock.method(client, 'listInstallationRepos', async () => remote);
  try {
    await refreshInstallationRepos(f.id);
    const root = db.collection('github_installations').doc(f.id);
    const binding = db.collection('github_installations').doc(`${f.id}_${f.b}`);
    assert.deepEqual((await root.get()).data()!.repositoryFullNames, [f.repos[0]]);
    assert.deepEqual((await binding.get()).data()!.repositoryFullNames, [f.repos[1]]);
    remote = remote.filter(r => r.full_name !== f.repos[1]);
    await refreshInstallationRepos(f.id);
    assert.deepEqual((await binding.get()).data()!.repositoryFullNames, []);
    await handleInstallationEvent('installation', { installation: { id:f.id }, action:'suspend' });
    assert.deepEqual((await root.get()).data()!.repositoryFullNames, []);
    assert.ok(!(await root.get()).data()!.tokenCache);
    await assert.rejects(saveWorkspaceConnection(f.c, f.uid, f.id, []));
    remote = f.details.map(r => ({ id:r.id, full_name:r.fullName, default_branch:r.defaultBranch }));
    await handleInstallationEvent('installation', { installation: { id:f.id }, action:'unsuspend' });
    assert.deepEqual((await binding.get()).data()!.repositoryFullNames, [f.repos[1]]);
    assert.ok(!(await binding.get()).data()!.suspendedAt);
    await handleInstallationEvent('installation', { installation: { id:f.id }, action:'deleted' });
    assert.deepEqual((await binding.get()).data()!.repositoryFullNames, []);
    await refreshInstallationRepos(f.id);
    assert.deepEqual((await root.get()).data()!.repositoryFullNames, []);
  } finally { stub.mock.restore(); }
});

class Webhook extends SyncFromWebhookAction { execute() { return this.handleAction(); } }
class Status extends GithubStatusAction { execute() { return this.handleAction(); } }

test('PR events in second workspace cannot update first workspace issues with same identifier', async () => {
  const f = await fixture();
  await saveWorkspaceConnection(f.b, f.uid, f.id, [f.repos[1]]);
  for (const workspaceId of [f.a,f.b]) await db.collection('issues').doc(`issue-${workspaceId}`).set({ workspaceId, identifier:'SAME-1', title:'sample', status:'todo', git:{repoFullName:f.repos[1],branch:'pul/same-1-sample'} });
  const result = await new Webhook({ actionCode:'github.syncFromWebhook', data:{event:'create', repoFullName:f.repos[1],branch:'pul/same-1-sample'} }).execute();
  assert.equal(result.issueId, `issue-${f.b}`);
  assert.equal((await db.collection('issues').doc(`issue-${f.a}`).get()).data()!.status, 'todo');
  assert.equal((await db.collection('issues').doc(`issue-${f.b}`).get()).data()!.status, 'in_progress');
});

test('member status cannot expose reusable accounts or token cache', async () => {
  const f = await fixture();
  await db.collection('members').doc(`${f.b}_${f.uid}`).update({role:'member'});
  const status = await new Status({actionCode:'github.status',data:{workspaceId:f.b}},f.uid).execute();
  assert.equal(status.connected,false);
  assert.deepEqual(status.availableConnections,[]);
  assert.ok(!JSON.stringify(status).includes('synthetic-private-token'));
});

import { githubSetup, buildInstallState } from '../github/install-flow';
process.env.MCP_KEY_PEPPER = 'synthetic-install-state-pepper';
async function setup(id: string, workspaceId: string, uid: string, state = buildInstallState(workspaceId, uid)) {
  let code = 200, redirect = '';
  const res: any = { status(n:number) { code=n; return this; }, send() {}, redirect(n:number,url:string) {code=n;redirect=url;} };
  await githubSetup({query:{installation_id:id,state}} as any,res);
  return {code,redirect};
}

test('setup callback preserves legacy ownership and rejects admin without source permission', async () => {
  const f = await fixture();
  const get = mock.method(client,'getInstallation',async () => ({id:Number(f.id),account:{login:'owner',type:'User'}}));
  const list = mock.method(client,'listInstallationRepos',async () => f.details.map(r => ({id:r.id,full_name:r.fullName,default_branch:r.defaultBranch})));
  try {
    assert.ok((await setup(f.id,f.b,f.uid)).redirect.endsWith('github=connected'));
    assert.equal((await db.collection('github_installations').doc(f.id).get()).data()!.workspaceId,f.a);
    assert.deepEqual((await db.collection('github_installations').doc(`${f.id}_${f.b}`).get()).data()!.repositoryFullNames,[]);
    const outsider = `outsider-${f.id}`;
    await db.collection('members').doc(`${f.c}_${outsider}`).set({workspaceId:f.c,userId:outsider,role:'owner'});
    assert.ok((await setup(f.id,f.c,outsider)).redirect.endsWith('github=error'));
    assert.ok(!(await db.collection('github_installations').doc(`${f.id}_${f.c}`).get()).exists);
    assert.equal((await setup(f.id,f.c,outsider,'invalid')).code,400);
  } finally {get.mock.restore();list.mock.restore();}
});

test('new installation starts without granted repos; reinstall preserves selection and a single workspace binding', async () => {
  const f = await fixture();
  const newId = `${f.id}77`;
  const get = mock.method(client,'getInstallation',async () => ({id:Number(newId),account:{login:'owner',type:'User'}}));
  const list = mock.method(client,'listInstallationRepos',async () => f.details.map(r => ({id:r.id,full_name:r.fullName,default_branch:r.defaultBranch})));
  try {
    assert.ok((await setup(newId,f.c,f.uid)).redirect.endsWith('github=connected'));
    assert.deepEqual((await db.collection('github_installations').doc(newId).get()).data()!.repositoryFullNames,[]);
    await handleInstallationEvent('installation',{installation:{id:f.id},action:'deleted'});
    const replacement = `${f.id}88`;
    assert.ok((await setup(replacement,f.a,f.uid)).redirect.endsWith('github=connected'));
    const connections = await db.collection('github_installations').where('workspaceId','==',f.a).get();
    assert.equal(connections.size,1);
    assert.equal(connections.docs[0].id,replacement);
    assert.deepEqual(connections.docs[0].data().repositoryFullNames,[f.repos[0]]);
  } finally {get.mock.restore();list.mock.restore();}
});

test('a workspace on a deleted installation can reuse the replacement without overwriting canonical metadata', async () => {
  const f = await fixture();
  await handleInstallationEvent('installation',{installation:{id:f.id},action:'deleted'});
  const replacement = `${f.id}99`;
  await db.collection('github_installations').doc(replacement).set({installationId:replacement,workspaceId:f.c,accountLogin:'owner',selectedRepositoryFullNames:[],repositoryFullNames:[],repositories:[],availableRepositories:f.details,tokenCache:{token:'synthetic-new-token'}});
  await saveWorkspaceConnection(f.a,f.uid,replacement,[f.repos[0]]);
  assert.ok(!(await db.collection('github_installations').doc(f.id).get()).data()!.workspaceId);
  assert.equal((await db.collection('github_installations').doc(replacement).get()).data()!.workspaceId,f.c);
  assert.equal((await db.collection('github_installations').doc(replacement).get()).data()!.tokenCache.token,'synthetic-new-token');
  assert.deepEqual((await db.collection('github_installations').where('workspaceId','==',f.a).get()).docs[0].data().repositoryFullNames,[f.repos[0]]);
});

test('approved multi-repo heads survive partial and final merge despite an older unmet self-check', async () => {
  const f = await fixture();
  await db.collection('github_installations').doc(f.id).update({repositoryFullNames:[f.repos[0],f.repos[1]]});
  const sha1 = 'a'.repeat(40), sha2 = 'b'.repeat(40), branch = 'pul/tes-379-test';
  const refs = [{repoFullName:f.repos[0],branch,prNumber:1,prState:'open',headSha:sha1}, {repoFullName:f.repos[1],branch,prNumber:2,prState:'open',headSha:sha2}];
  const id = `issue-merge-${f.id}`;
  await db.collection('issues').doc(id).set({workspaceId:f.a,teamId:'team-test',identifier:'TES-379',status:'in_review',
    git:{repoFullName:f.repos[0],branch,lastSyncedStatus:'in_review'},gitRefs:refs,
    devSelfCheckAt:'2026-01-01T00:00:00Z',devSelfCheck:[{criterionId:'criterion',result:'not_met'}],
    review:{state:'approved',completedAt:'2026-01-02T00:00:00Z',prs:refs,criteriaResults:[{criterionId:'criterion',result:'pass'}]},
  });
  for (let i=0;i<2;i++) {
    await new Webhook({actionCode:'github.syncFromWebhook',data:{event:'pull_request',prAction:'closed',repoFullName:refs[i].repoFullName,branch,prNumber:refs[i].prNumber,headSha:refs[i].headSha,merged:true}}).execute();
    const issue = (await db.collection('issues').doc(id).get()).data()!;
    assert.equal(issue.review.state,'approved');
    assert.equal(issue.status, i === 0 ? 'in_review' : 'done');
  }
});

test('a changed approved PR scope never closes on later merges, even without pending self-check', async () => {
  const f = await fixture();
  await db.collection('github_installations').doc(f.id).update({repositoryFullNames:f.repos});
  const branch='pul/tes-379-stale', hashes=['a'.repeat(40),'b'.repeat(40),'c'.repeat(40)];
  const refs=f.repos.map((repoFullName,i)=>({repoFullName,branch,prNumber:i+1,prState:i===2?'merged':'open',headSha:hashes[i]}));
  const id=`issue-stale-${f.id}`;
  await db.collection('issues').doc(id).set({workspaceId:f.a,teamId:'team-test',identifier:'TES-379',status:'in_review',git:{repoFullName:f.repos[0],branch,lastSyncedStatus:'in_review'},gitRefs:refs,
    review:{state:'approved',attempt:1,prs:refs.slice(0,2),criteriaResults:[]}});
  for(let i=0;i<2;i++) {
    await new Webhook({actionCode:'github.syncFromWebhook',data:{event:'pull_request',prAction:'closed',repoFullName:refs[i].repoFullName,branch,prNumber:refs[i].prNumber,headSha:refs[i].headSha,merged:true}}).execute();
    const issue=(await db.collection('issues').doc(id).get()).data()!;
    assert.equal(issue.review.state, i === 0 ? 'stale' : 'running'); assert.ok(issue.reviewScopeInvalidatedAt);
    assert.equal(issue.status,'in_review');
    if (i === 0) await db.collection('issues').doc(id).update({review:{state:'running',attempt:2}});
  }
  const current = (await db.collection('issues').doc(id).get()).data()!;
  await db.collection('issues').doc(id).update({review:{state:'approved',attempt:2,prs:current.gitRefs}});
  await new Webhook({actionCode:'github.syncFromWebhook',data:{event:'pull_request',prAction:'closed',repoFullName:refs[1].repoFullName,branch,prNumber:refs[1].prNumber,headSha:refs[1].headSha,merged:true}}).execute();
  assert.equal((await db.collection('issues').doc(id).get()).data()!.status,'done');
});
