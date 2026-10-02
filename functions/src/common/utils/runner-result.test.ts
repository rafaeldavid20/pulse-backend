import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRunnerFailure, safeRunnerJobResult } from './runner-result';
test('completion redacts credentials before retaining the tail', () => {
  const result = safeRunnerJobResult('prefix'.repeat(100) + ' sk-ant-test_secret ghp_test_token Bearer test.token runner-123456789012.' + 'testsecret'.repeat(5) + ' cause: denied');
  assert.ok(result?.endsWith('cause: denied'));
  assert.equal(result?.includes('test_secret'), false);
  assert.equal(result?.includes('testsecret'), false);
  assert.ok(result && result.length <= 500);
});
test('failure metadata rejects arbitrary text and ties correlation to the authenticated job', () => {
  assert.deepEqual(safeRunnerFailure({ phase: 'local-preflight', category: 'local_preparation', correlationId: 'other', credential: 'never-store' }, 'rjob-1'), { phase: 'local-preflight', category: 'local_preparation', correlationId: 'rjob-1' });
  assert.equal(safeRunnerFailure({ phase: 'Bearer token', category: 'configuration' }, 'rjob-1'), null);
  assert.equal(safeRunnerFailure({ phase: 'run-agent', category: 'unknown' }, 'rjob-1'), null);
});
