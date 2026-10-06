import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertQaReviewedHeads, assertQaPrepared, qaArchive, qaProjectRepos, qaSourceAuthorization, resolveQaRepo, withQaRepo } from '../../qa/source';
import { QA_SOURCE_SCRIPT } from '../../github/templates/qa-source-step';
import { renderQaWorkflow } from '../../github/templates/pulse-qa-workflow';
const sha = 'a'.repeat(40);
const repos = ['o/app', 'o/backend', 'o/private-runner'];
const project = { workspaceId: 'ws', repoFullNames: repos };
const refs = [{ repoFullName: repos[2], prNumber: 7, branch: 'pul/fix' }];

test('project boundary includes private/context repos, catches additions, removals and wrong workspace', () => {
  assert.deepEqual(qaProjectRepos(project, 'ws', refs), repos);
  const proof = { workspaceId: 'ws', checkedAt: new Date().toISOString(), repositories: repos.map((repo) => ({ repo, sha, ...(repo === repos[2] ? { prNumber: 7 } : {}) })), downloaded: Object.fromEntries(repos.map((repo) => [repo, sha])) };
  assert.equal(assertQaPrepared(proof, project, 'ws', refs).length, 3);
  assert.throws(() => assertQaPrepared(proof, { ...project, repoFullNames: [...repos, 'o/new'] }, 'ws', refs));
  assert.throws(() => assertQaPrepared(proof, { ...project, repoFullNames: repos.slice(1) }, 'ws', refs));
  assert.throws(() => qaProjectRepos(project, 'other', refs));
  assert.throws(() => assertQaPrepared({ ...proof, downloaded: {} }, project, 'ws', refs));
  assert.throws(() => assertQaPrepared({ ...proof, checkedAt: new Date(0).toISOString() }, project, 'ws', refs));
});

test('QA source uses a separate application credential header and preserves legacy bearer callers', () => {
  assert.equal(qaSourceAuthorization('pulse-fixture-key'), 'Bearer pulse-fixture-key');
  assert.equal(qaSourceAuthorization('  pulse-fixture-key  '), 'Bearer pulse-fixture-key');
  assert.equal(qaSourceAuthorization('', 'Bearer legacy-fixture-key'), 'Bearer legacy-fixture-key');
  assert.equal(qaSourceAuthorization(undefined), undefined);
  assert(QA_SOURCE_SCRIPT.includes("'X-Pulse-QA-Credential': os.environ['PULSE_QA_CREDENTIAL']"));
});

test('preflight resolves exact PR heads, context default heads, metadata and content', async () => {
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    return Response.json(path === '' ? { full_name: repos[2], default_branch: 'main' } : path.startsWith('pulls') ? { head: { sha, ref: 'pul/fix', repo: { full_name: repos[2] } }, base: { repo: { full_name: repos[2] } } } : { sha });
  };
  assert.deepEqual(await resolveQaRepo(repos[2], refs[0], get), { repo: repos[2], sha, prNumber: 7 });
  assert(calls.includes(`git/trees/${sha}`));
  assert.equal((await resolveQaRepo(repos[2], null, get)).sha, sha);
  await assert.rejects(resolveQaRepo(repos[2], { ...refs[0], branch: 'wrong' }, get));
  await assert.rejects(resolveQaRepo('o/outside', null, get));
});

test('fresh per-repo read-only identity, archive access and immediate revocation, including failures', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'fixture-only' });
    return new Response('snapshot');
  }) as typeof fetch;
  await withQaRepo('1', repos[2], async (get) => { assert.equal((await qaArchive(get, sha)).toString(), 'snapshot'); }, fetcher, () => 'fixture-jwt');
  assert.deepEqual(JSON.parse(calls[0].init!.body as string), { repositories: ['private-runner'], permissions: { contents: 'read', pull_requests: 'read' } });
  assert.equal(calls.at(-1)!.init!.method, 'DELETE');
  calls.length = 0;
  await assert.rejects(withQaRepo('1', repos[2], async () => { throw new Error('revoked'); }, fetcher, () => 'fixture-jwt'));
  assert.equal(calls.at(-1)!.init!.method, 'DELETE');
  await assert.rejects(withQaRepo('1', repos[2], async () => {}, (async () => new Response('private body', { status: 403 })) as typeof fetch, () => 'fixture-jwt'), /private-runner.*HTTP 403/);
});

test('workflow prepares before isolated verification and review, never checks out with persisted git auth', () => {
  const workflow = renderQaWorkflow();
  assert(workflow.includes('needs: prepare'));
  assert(workflow.includes("needs.prepare.result == 'success'"));
  assert(workflow.includes('persist-credentials: false'));
  assert(!workflow.includes('name: qa-sources'));
  assert(workflow.includes('ref: ${{ needs.prepare.outputs.head_sha }}'));
  const verify = workflow.split('  verify:')[1].split('  review:')[0];
  assert(!verify.includes('secrets.'));
  assert(!verify.includes('GH_TOKEN'));
  assert(QA_SOURCE_SCRIPT.includes("stat.S_ISLNK(mode)"));
});

test('verdict cannot record a moved head or a revoked/unreadable PR as reviewed', () => {
  const reviewed = [{ repoFullName: repos[2], prNumber: 7, headSha: sha }];
  assert.doesNotThrow(() => assertQaReviewedHeads(reviewed, reviewed, reviewed));
  assert.throws(() => assertQaReviewedHeads(reviewed, reviewed, [{ ...reviewed[0], headSha: 'b'.repeat(40) }]));
  assert.throws(() => assertQaReviewedHeads(reviewed, reviewed, []));
  assert.throws(() => assertQaReviewedHeads(reviewed, [{ ...reviewed[0], prNumber: 8 }], reviewed));
});
