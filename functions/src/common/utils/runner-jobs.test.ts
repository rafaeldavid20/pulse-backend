import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'crypto';
import { signRunnerJob, runnerJobPayload } from './runner-jobs';
import { isRunnerAvailable } from './runner-availability';
import { safeRunnerJobResult } from './runner-result';

const unsigned = {
  id: 'rjob-example', workspaceId: 'ws-1', issueId: 'issue-1', agentId: 'agent-1',
  runnerId: 'runner-123456789012', repoFullName: 'owner/repo', mode: 'task' as const,
  issuedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-24T00:05:00.000Z',
  signatureAlgorithm: 'ed25519' as const, signingKeyId: 'runner-job-v1',
};

test('la firma de un Runner job ata identidad, repo, modo y vencimiento', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = signRunnerJob(unsigned, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  assert.equal(verify(null, Buffer.from(runnerJobPayload(unsigned)), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(verify(null, Buffer.from(runnerJobPayload({ ...unsigned, repoFullName: 'owner/other' })), publicKey, Buffer.from(signature, 'base64url')), false);
});

test('un Runner online sin heartbeat reciente no puede recibir jobs', () => {
  const now = Date.parse('2026-09-24T00:05:00.000Z');
  assert.equal(isRunnerAvailable({ status: 'online', lastHeartbeatAt: '2026-09-24T00:04:00.000Z' }, now), true);
  assert.equal(isRunnerAvailable({ status: 'online', lastHeartbeatAt: '2026-09-24T00:02:59.999Z' }, now), false);
  assert.equal(isRunnerAvailable({ status: 'online' }, now), false);
});

test('el resumen de un job no conserva tokens de proveedores', () => {
  const result = safeRunnerJobResult('Falló con Bearer abc.def-gh y sk-ant-api03-SECRET ghp_012345');
  assert.equal(result, 'Falló con Bearer [redacted] y [redacted] [redacted]');
});
