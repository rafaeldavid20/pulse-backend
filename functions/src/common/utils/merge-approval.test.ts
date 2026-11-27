import test from 'node:test';
import assert from 'node:assert/strict';
import { uncoveredNotMetCriteria } from './pending-work';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const refs = [{repoFullName:'owner/app',prNumber:1,headSha:a}, {repoFullName:'owner/backend',prNumber:2,headSha:b}];
const issue = () => ({
  gitRefs: refs.map(r => ({...r})), devSelfCheckAt:'2026-01-01T00:00:00Z',
  devSelfCheck:[{criterionId:'c',result:'not_met'}],
  review:{state:'approved',completedAt:'2026-01-02T00:00:00Z',prs:refs.map(r => ({...r})),criteriaResults:[{criterionId:'c',result:'pass'}]},
});

test('a later independent QA pass covers an old failure only on the exact full PR set', () => {
  assert.deepEqual(uncoveredNotMetCriteria(issue()), []);
  for (const change of [
    (x:any) => x.gitRefs[0].headSha = b,
    (x:any) => x.review.prs.pop(),
    (x:any) => x.review.state = 'needs_human',
    (x:any) => x.review.overriddenBy = 'human',
    (x:any) => x.review.completedAt = '2025-12-31T00:00:00Z',
    (x:any) => x.review.criteriaResults[0].result = 'unverifiable',
    (x:any) => x.review.criteriaResults = [],
  ]) { const x = issue(); change(x); assert.deepEqual(uncoveredNotMetCriteria(x), ['c']); }
});
