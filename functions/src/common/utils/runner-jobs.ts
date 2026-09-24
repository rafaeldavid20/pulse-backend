import { Firestore } from 'firebase-admin/firestore';
import { createHmac } from 'crypto';
import { nanoid } from 'nanoid';
import { RunnerJob } from '../domain.generated';

const JOB_TTL_MS = 5 * 60 * 1000;

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signedPayload(job: Omit<RunnerJob, 'signature'>): string {
  // La lista explícita evita que campos operativos agregados al documento de
  // Firestore (p. ej. deliveredAt) alteren la verificación del Runner.
  return [job.id, job.workspaceId, job.issueId, job.agentId, job.runnerId, job.repoFullName, job.mode, job.issuedAt, job.expiresAt].join('.');
}

export function signRunnerJob(job: Omit<RunnerJob, 'signature'>, pepper: string): string {
  return base64url(createHmac('sha256', pepper).update(signedPayload(job)).digest());
}

/** Crea un trabajo de vida corta. El documento no contiene ninguna credencial de proveedor. */
export async function enqueueRunnerJob(
  db: Firestore,
  input: Omit<RunnerJob, 'id' | 'issuedAt' | 'expiresAt' | 'signature'>,
  pepper: string,
): Promise<RunnerJob> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  const unsigned = { id: `rjob-${nanoid(12)}`, ...input, issuedAt, expiresAt };
  const job: RunnerJob = { ...unsigned, signature: signRunnerJob(unsigned, pepper) };
  await db.collection('runner_jobs').doc(job.id).set({ ...job, status: 'pending', createdAt: issuedAt });
  return job;
}
