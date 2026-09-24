import test from 'node:test';
import assert from 'node:assert/strict';
import { signRunnerJob } from './runner-jobs';

const unsigned = {
  id: 'rjob-example', workspaceId: 'ws-1', issueId: 'issue-1', agentId: 'agent-1',
  runnerId: 'runner-123456789012', repoFullName: 'owner/repo', mode: 'task' as const,
  issuedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-24T00:05:00.000Z',
};

test('la firma de un Runner job ata identidad, repo, modo y vencimiento', () => {
  const signature = signRunnerJob(unsigned, 'pepper');
  assert.equal(signature, signRunnerJob(unsigned, 'pepper'));
  assert.notEqual(signature, signRunnerJob({ ...unsigned, repoFullName: 'owner/other' }, 'pepper'));
  assert.notEqual(signature, signRunnerJob({ ...unsigned, mode: 'rework' }, 'pepper'));
  assert.notEqual(signature, signRunnerJob({ ...unsigned, expiresAt: '2026-09-24T00:06:00.000Z' }, 'pepper'));
});
