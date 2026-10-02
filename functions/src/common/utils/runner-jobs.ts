import { Firestore } from 'firebase-admin/firestore';
import { sign } from 'crypto';
import { nanoid } from 'nanoid';
import { RunnerJob } from '../domain.generated';

// Un adaptador local puede necesitar instalar dependencias, ejecutar tests y
// abrir/actualizar un PR. Cinco minutos alcanzan para entregar el envelope,
// pero no para completar de forma fiable una sesión real de Codex o Claude.
const JOB_TTL_MS = 30 * 60 * 1000;

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function runnerJobPayload(job: Omit<RunnerJob, 'signature'>): string {
  // La lista explícita evita que campos operativos agregados al documento de
  // Firestore (p. ej. deliveredAt) alteren la verificación del Runner.
  const contextRepos = [...new Set(job.contextRepos || [job.repoFullName])].sort().join(',');
  return [job.id, job.workspaceId, job.issueId, job.agentId, job.runnerId, job.repoFullName, contextRepos, job.mode, job.issuedAt, job.expiresAt, job.signatureAlgorithm, job.signingKeyId].join('.');
}

export function signRunnerJob(job: Omit<RunnerJob, 'signature'>, privateKey: string): string {
  return base64url(sign(null, Buffer.from(runnerJobPayload(job)), privateKey));
}

/** Crea un trabajo de vida corta. El documento no contiene ninguna credencial de proveedor. */
export async function enqueueRunnerJob(
  db: Firestore,
  input: Omit<RunnerJob, 'id' | 'issuedAt' | 'expiresAt' | 'signature' | 'signatureAlgorithm' | 'signingKeyId'>,
  privateKey: string,
  signingKeyId = 'runner-job-v1',
): Promise<RunnerJob> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  const contextRepos = [...new Set(input.contextRepos || [input.repoFullName])].sort();
  const unsigned = { id: `rjob-${nanoid(12)}`, ...input, contextRepos, issuedAt, expiresAt, signatureAlgorithm: 'ed25519' as const, signingKeyId };
  const job: RunnerJob = { ...unsigned, signature: signRunnerJob(unsigned, privateKey) };
  const agentRef = db.collection('agents').doc(job.agentId);
  await db.runTransaction(async (transaction) => {
    const agent = await transaction.get(agentRef);
    if (!agent.exists || agent.data()?.workspaceId !== job.workspaceId) {
      throw new Error('El agente ejecutor ya no existe en este workspace.');
    }
    if (agent.data()?.archivedAt) {
      throw new Error('No se pueden emitir jobs para un agente archivado. Restauralo primero.');
    }
    transaction.update(agentRef, { runnerJobDispatchAt: issuedAt });
    transaction.create(db.collection('runner_jobs').doc(job.id), { ...job, status: 'pending', createdAt: issuedAt });
  });
  return job;
}
