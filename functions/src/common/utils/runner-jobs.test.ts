import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'crypto';
import { enqueueRunnerJob, signRunnerJob, runnerJobPayload } from './runner-jobs';
import { isRunnerAvailable } from './runner-availability';

const unsigned = {
  id: 'rjob-example', workspaceId: 'ws-1', issueId: 'issue-1', agentId: 'agent-1',
  runnerId: 'runner-123456789012', repoFullName: 'owner/repo', contextRepos: ['owner/app', 'owner/repo'], mode: 'task' as const,
  issuedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-24T00:05:00.000Z',
  signatureAlgorithm: 'ed25519' as const, signingKeyId: 'runner-job-v1',
};

test('la firma de un Runner job ata identidad, repos de contexto, modo y vencimiento', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = signRunnerJob(unsigned, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  assert.equal(verify(null, Buffer.from(runnerJobPayload(unsigned)), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(verify(null, Buffer.from(runnerJobPayload({ ...unsigned, repoFullName: 'owner/other' })), publicKey, Buffer.from(signature, 'base64url')), false);
  assert.equal(verify(null, Buffer.from(runnerJobPayload({ ...unsigned, contextRepos: ['owner/repo'] })), publicKey, Buffer.from(signature, 'base64url')), false);
});

test('un Runner online sin heartbeat reciente no puede recibir jobs', () => {
  const now = Date.parse('2026-09-24T00:05:00.000Z');
  assert.equal(isRunnerAvailable({ status: 'online', lastHeartbeatAt: '2026-09-24T00:04:00.000Z' }, now), true);
  assert.equal(isRunnerAvailable({ status: 'online', lastHeartbeatAt: '2026-09-24T00:02:59.999Z' }, now), false);
  assert.equal(isRunnerAvailable({ status: 'online' }, now), false);
});

test('emitir un job comprueba que el agente siga activo y serializa el alta con el archivado', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const writes: Array<{ kind: string; ref: any; value: any }> = [];
  const db = {
    collection(name: string) {
      return { doc(id: string) { return { collection: name, id }; }, where() { return { collection: name }; } };
    },
    async runTransaction(work: (transaction: any) => Promise<void>) {
      const transaction = {
        async get(ref: any) {
          if (ref.collection === 'issues') return { exists: true, data: () => ({ workspaceId: 'ws-1' }) };
          if (ref.collection === 'runner_jobs') return { docs: [] };
          if (ref.collection === 'runners') return { exists: true, data: () => ({
            workspaceId: 'ws-1', id: 'runner-123456789012', status: 'online', lastHeartbeatAt: new Date().toISOString(),
            connectedRepos: ['owner/repo'], readinessCheckedAt: new Date().toISOString(), readiness: {
              workspaceId: 'ws-1', identities: [{ agentId: 'agent-1', kind: 'codex', role: 'dev' }],
              providers: { codex: { cli: true, session: true } }, repositories: [{ repo: 'owner/repo', accessible: true }],
            },
          }) };
          return { exists: true, data: () => ({ workspaceId: 'ws-1', enabled: true, kind: 'codex', role: 'dev', runnerId: 'runner-123456789012', allowedRepos: ['owner/repo'] }) };
        },
        update(ref: any, value: any) { writes.push({ kind: 'update', ref, value }); },
        create(ref: any, value: any) { writes.push({ kind: 'create', ref, value }); },
      };
      await work(transaction);
    },
  } as any;

  const job = await enqueueRunnerJob(db, {
    workspaceId: 'ws-1', issueId: 'issue-1', agentId: 'agent-1', runnerId: 'runner-123456789012',
    repoFullName: 'owner/repo', mode: 'task',
  }, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

  assert.equal(writes.length, 3);
  assert.equal(writes.shift()!.ref.collection, 'runners');
  assert.equal(writes[0].kind, 'update');
  assert.equal(writes[0].ref.collection, 'agents');
  assert.equal(writes[0].value.runnerJobDispatchAt, job.issuedAt);
  assert.equal(writes[1].kind, 'create');
  assert.equal(writes[1].ref.collection, 'runner_jobs');
  assert.equal(writes[1].value.status, 'pending');
});

test('la emisión de jobs rechaza agentes archivados antes de escribir el job', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const writes: unknown[] = [];
  const db = {
    collection(name: string) {
      return { doc(id: string) { return { collection: name, id }; }, where() { return { collection: name }; } };
    },
    async runTransaction(work: (transaction: any) => Promise<void>) {
      await work({
        async get() { return { exists: true, data: () => ({ workspaceId: 'ws-1', archivedAt: '2026-10-01T00:00:00.000Z' }) }; },
        update(...args: unknown[]) { writes.push(args); },
        create(...args: unknown[]) { writes.push(args); },
      });
    },
  } as any;

  await assert.rejects(
    enqueueRunnerJob(db, {
      workspaceId: 'ws-1', issueId: 'issue-1', agentId: 'agent-1', runnerId: 'runner-123456789012',
      repoFullName: 'owner/repo', mode: 'task',
    }, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
    /agente archivado/
  );
  assert.equal(writes.length, 0);
});
