import test from 'node:test';
import assert from 'node:assert/strict';
import { getPullRequestReviewEvidence } from '../../github/client';
const sha='a'.repeat(40);

test('review evidence includes PR body and independent checks bound to the authorized head',async()=>{
 const paths:string[]=[];
 const get=async(_installation:string,path:string)=>{
  paths.push(path);
  if(path.includes('/pulls/')) return {title:'Fix',body:'Acceptance evidence',head:{sha}};
  if(path.includes('/check-runs')) return {total_count:1,check_runs:[{name:'verify',head_sha:sha,status:'completed',conclusion:'success',details_url:'https://github.com/o/r/actions/runs/1'}]};
  if(path.includes('/status?')) return {state:'success',total_count:1,statuses:[{context:'verify',state:'success'}]};
  return {total_count:2,workflow_runs:[{name:'CI',head_sha:sha,status:'completed',conclusion:'success'},{name:'other HEAD',head_sha:'b'.repeat(40),conclusion:'success'}]};
 };
 const evidence=await getPullRequestReviewEvidence('installation','o/r',95,sha,get);
 assert.equal(evidence.body,'Acceptance evidence');
 assert.equal(evidence.headSha,sha);
 assert.equal(evidence.checkRuns.runs[0].conclusion,'success');
 assert.equal(evidence.workflowRuns.runs.length,1);
 assert(paths.slice(1).every(path=>path.includes(sha)));
 await assert.rejects(getPullRequestReviewEvidence('installation','o/r',95,'c'.repeat(40),get),/HEAD/);
});

test('review evidence makes truncation and unavailable checks explicit without reflecting remote errors',async()=>{
 const evidence=await getPullRequestReviewEvidence('installation','o/r',95,sha,async(_installation,path)=>{
  if(path.includes('/pulls/')) return {body:'x'.repeat(60001),head:{sha}};
  if(path.includes('/status?')) return {state:'pending',statuses:[]};
  throw new Error('private credential sentinel');
 });
 assert.equal(evidence.body.length,60000);
 assert.equal(evidence.bodyTruncated,true);
 assert.equal(evidence.commitStatus.state,'pending');
 assert(evidence.checkRunsError && evidence.workflowRunsError);
 assert(!JSON.stringify(evidence).includes('private credential sentinel'));
 assert.equal(evidence.checkRuns,undefined);
});
