import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCompleteDevSelfCheck } from './dev-self-check';

const deliveredAt = '2026-10-23T10:00:00.000Z';
const ready = {
  acceptanceCriteria: [{id:'a'}, {id:'b'}], devSelfCheckJobId:'job-1', devSelfCheckAt:'2026-10-23T10:01:00.000Z',
  devSelfCheck:[{criterionId:'a',result:'met',evidence:'src/a.ts'}, {criterionId:'b',result:'met',evidence:'npm test'}],
};

test('automatic QA eligibility requires fresh, complete, all-met evidence for a completed delivery', () => {
  assert.equal(hasCompleteDevSelfCheck(ready, {definitionOfDone:[{id:'d'}]}, 'job-1', deliveredAt), false);
  const complete = {...ready, devSelfCheck:[...ready.devSelfCheck, {criterionId:'d',result:'met',evidence:'npm run build'}]};
  assert.equal(hasCompleteDevSelfCheck(complete, {definitionOfDone:[{id:'d'}]}, 'job-1', deliveredAt), true);
  assert.equal(hasCompleteDevSelfCheck({...complete, devSelfCheckJobId:'older'}, {definitionOfDone:[{id:'d'}]}, 'job-1', deliveredAt), false);
  assert.equal(hasCompleteDevSelfCheck({...complete, devSelfCheckAt:'2026-10-23T09:59:00.000Z'}, {definitionOfDone:[{id:'d'}]}, 'job-1', deliveredAt), false);
  assert.equal(hasCompleteDevSelfCheck({...complete, devSelfCheck:complete.devSelfCheck.map(c=>c.criterionId==='b'?{...c,result:'not_met'}:c)}, {definitionOfDone:[{id:'d'}]}, 'job-1', deliveredAt), false);
});
