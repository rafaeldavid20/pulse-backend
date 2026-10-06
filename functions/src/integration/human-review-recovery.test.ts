import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ReturnToAgentAction } from '../actions/reviews/return-to-agent';
import { checkIssueRunBudget } from '../common/utils/issue-run-budget';
if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Firestore Emulator is required');
if (!getApps().length) initializeApp({projectId:'pulse-integration'});
const db=getFirestore();
const prefix='recover-'+Date.now(), ws=prefix+'-ws', owner=prefix+'-owner', dev=prefix+'-dev', qa=prefix+'-qa';
const oldTime=new Date(Date.now()-60_000).toISOString();
async function seed(name:string, overrides:any={}) {
 const id=prefix+'-'+name;
 await db.collection('workspaces').doc(ws).set({maxRunsPerIssue:6});
 await db.collection('members').doc(ws+'_'+owner).set({workspaceId:ws,userId:owner,role:'owner'});
 await db.collection('members').doc(ws+'_'+qa).set({workspaceId:ws,userId:qa,role:'member',isAgent:true});
 await db.collection('agents').doc(dev).set({workspaceId:ws,role:'dev',enabled:true});
 await db.collection('agents').doc(qa).set({workspaceId:ws,role:'qa',enabled:true});
 await db.collection('issues').doc(id).set({id,workspaceId:ws,identifier:'INT-'+name,assigneeId:dev,status:'in_progress',review:{state:'needs_human',attempt:0,dispatchedTo:qa},...overrides});
 const batch=db.batch(); for(let i=0;i<6;i++) batch.set(db.collection('agent_runs').doc(id+'-run-'+i),{workspaceId:ws,issueId:id,startedAt:oldTime,costUsd:1});await batch.commit();return id;
}
function action(issueId:string,caller=owner) {return new ReturnToAgentAction({actionCode:'reviews.returnToAgent',data:{issueId,comment:'Reintento humano tras corregir infraestructura.'}},caller).run();}

test('emulator: human recovery handles unclaimed QA and renews only this issue batch',async()=>{
 const id=await seed('renew'), other=await seed('other');
 assert.equal((await checkIssueRunBudget(db,ws,id)).withinBudget,false);
 const result=await action(id);assert.equal(result.success,true,JSON.stringify(result));
 const issue=(await db.collection('issues').doc(id).get()).data()!;
 assert.equal(issue.assigneeId,dev);assert.equal(issue.review.state,'pending');assert.equal(issue.review.attempt,0);
 assert.equal(issue.review.history[0].state,'needs_human');assert.equal(issue.runBudgetResetBy,owner);
 assert.equal((await checkIssueRunBudget(db,ws,id)).withinBudget,true);
 assert.equal((await checkIssueRunBudget(db,ws,other)).withinBudget,false);
 assert.equal((await db.collection('agent_runs').where('issueId','==',id).get()).size,6);
 await db.collection('workspaces').doc(ws).update({issueCostCapUsd:5});
 assert.deepEqual(await checkIssueRunBudget(db,ws,id),{withinBudget:false,reason:'issue-cost-cap',capUsd:5});
 await db.collection('workspaces').doc(ws).update({issueCostCapUsd:100});
 const batch=db.batch();for(let i=0;i<6;i++) batch.set(db.collection('agent_runs').doc(id+'-new-'+i),{issueId:id,startedAt:new Date(Date.now()+1000).toISOString()});await batch.commit();
 assert.deepEqual(await checkIssueRunBudget(db,ws,id),{withinBudget:false,reason:'issue-run-limit',limit:6});
});
test('emulator: agent mirrors cannot renew budget; QA and foreign dev assignments fail safely',async()=>{
 const id=await seed('agent-denied');assert.equal((await action(id,qa)).success,false);
 assert.equal((await db.collection('issues').doc(id).get()).data()?.runBudgetResetAt,undefined);
 const bad=await seed('qa-assignee',{assigneeId:qa});assert.equal((await action(bad)).success,false);
 await db.collection('agents').doc(dev).update({workspaceId:'foreign'});
 const foreign=await seed('foreign');await db.collection('agents').doc(dev).update({workspaceId:'foreign'});
 assert.equal((await action(foreign)).success,false);
});
test('emulator: concurrent returns archive once; future reset timestamps grant nothing',async()=>{
 const id=await seed('concurrent');const results=await Promise.all([action(id),action(id)]);
 assert.equal(results.filter(x=>x.success).length,1);
 assert.equal((await db.collection('issues').doc(id).get()).data()?.review.history.length,1);
 const future=await seed('future',{runBudgetResetAt:new Date(Date.now()+60_000).toISOString(),runBudgetResetBy:owner});
 assert.equal((await checkIssueRunBudget(db,ws,future)).withinBudget,false);
});
