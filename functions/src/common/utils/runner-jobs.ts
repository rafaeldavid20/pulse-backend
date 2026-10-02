import { Firestore } from 'firebase-admin/firestore';
import { sign } from 'crypto';
import { nanoid } from 'nanoid';
import { runnerPreflight } from './runner-preflight';
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
    const runner = await transaction.get(db.collection('runners').doc(job.runnerId));
    const preflight = runnerPreflight({ ...agent.data(), id: job.agentId }, runner.exists ? { ...runner.data(), id: job.runnerId } : null, job.workspaceId, contextRepos, job.mode);
    if (!preflight.ready) throw new Error(`Preflight: ${preflight.problems.map((problem) => `${problem.message} ${problem.action}`).join(' ')}`);
    const active = await transaction.get(db.collection('runner_jobs').where('runnerId', '==', job.runnerId));
    const count = active.docs.filter((snap) => ['pending', 'delivered'].includes(snap.data().status) && (!Number.isFinite(Date.parse(snap.data().expiresAt)) || Date.parse(snap.data().expiresAt) > Date.now())).length;
    if (count >= (runner.data()!.maxConcurrentJobs || 1)) throw new Error('El Runner ya alcanzó su capacidad de jobs activos.');
    const issue = await transaction.get(db.collection('issues').doc(job.issueId));
    const data = issue.data();
    if (!issue.exists || data?.workspaceId !== job.workspaceId) throw new Error('El issue no existe en este workspace.');
    if (job.mode === 'review') {
      const reviewRepos = data?.gitRefs?.length ? data.gitRefs.filter((ref: any) => ref.prNumber !== undefined).map((ref: any) => ref.repoFullName) : data?.git?.prNumber !== undefined ? [data.git.repoFullName] : [];
      if (!issue.exists || data?.workspaceId !== job.workspaceId || contextRepos.some((repo) => !reviewRepos.includes(repo))) throw new Error('Los repos de revisión deben pertenecer a los PRs del issue en este workspace.');
    }
    transaction.update(db.collection('runners').doc(job.runnerId), { lastDispatchAt: issuedAt });
    transaction.update(agentRef, { runnerJobDispatchAt: issuedAt });
    transaction.create(db.collection('runner_jobs').doc(job.id), { ...job, status: 'pending', createdAt: issuedAt });
  });
  return job;
}
