import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { sign } from 'crypto';
import { nanoid } from 'nanoid';
import { runnerPreflight } from './runner-preflight';
import { currentRunnerProjectAccess } from './project-repos';
import { DISPATCH_COOLDOWN_MS, RunnerDispatchError } from './dispatch-failure';
import { checkWorkspaceDispatchBudget, todayKey } from './dispatch-counter';
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
  const fields = [job.id, job.workspaceId, job.issueId, job.agentId, job.runnerId, job.repoFullName, contextRepos, job.mode, job.issuedAt, job.expiresAt, job.signatureAlgorithm, job.signingKeyId];
  return (job.protocolVersion === 2 ? [...fields, job.protocolVersion, job.projectId] : fields).join('.');
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
  taskDispatch = false,
): Promise<RunnerJob> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  const contextRepos = [...new Set(input.contextRepos || [input.repoFullName])].sort();
  const unsigned = { id: `rjob-${nanoid(12)}`, ...input, contextRepos, issuedAt, expiresAt, signatureAlgorithm: 'ed25519' as const, signingKeyId };
  let job: RunnerJob = { ...unsigned, signature: '' };
  const agentRef = db.collection('agents').doc(job.agentId);
  await db.runTransaction(async (transaction) => {
    const agent = await transaction.get(agentRef);
    if (!agent.exists || agent.data()?.workspaceId !== job.workspaceId) {
      throw new Error('El agente ejecutor ya no existe en este workspace.');
    }
    if (agent.data()?.archivedAt) {
      throw new Error('No se pueden emitir jobs para un agente archivado. Restauralo primero.');
    }
    const issueRef = db.collection('issues').doc(job.issueId);
    if (taskDispatch) {
      const issue = (await transaction.get(issueRef)).data();
      if (!issue || issue.status !== 'todo' || (issue.execution?.agentId || issue.assigneeId) !== job.agentId || issue.agent?.state === 'claimed') {
        throw new RunnerDispatchError('enqueue', ['La issue ya no está disponible para este dispatch.'], true);
      }
      if (issue.agent?.dispatchedTo === job.agentId && Date.now() - Date.parse(issue.agent.dispatchedAt || '') < DISPATCH_COOLDOWN_MS) {
        throw new RunnerDispatchError('enqueue', ['La issue ya tiene un dispatch reciente.'], true);
      }
    }
    const runner = await transaction.get(db.collection('runners').doc(job.runnerId));
    const preflight = runnerPreflight({ ...agent.data(), id: job.agentId }, runner.exists ? { ...runner.data(), id: job.runnerId } : null, job.workspaceId, contextRepos, job.mode, Date.now(), true);
    if (!preflight.ready) throw new RunnerDispatchError('preflight', preflight.problems.map((problem) => `${problem.message} ${problem.action}`));
    const active = await transaction.get(db.collection('runner_jobs').where('runnerId', '==', job.runnerId));
    const activeJobs = active.docs.filter((snap) => ['pending', 'delivered'].includes(snap.data().status) && (!Number.isFinite(Date.parse(snap.data().expiresAt)) || Date.parse(snap.data().expiresAt) > Date.now()));
    if (taskDispatch && activeJobs.some((snap) => snap.data().issueId === job.issueId && snap.data().mode === 'task')) {
      throw new RunnerDispatchError('enqueue', ['La issue ya tiene un job activo.'], true);
    }
    const count = activeJobs.length;
    if (count >= (runner.data()!.maxConcurrentJobs || 1)) throw new RunnerDispatchError('enqueue', ['El Runner ya alcanzó su capacidad de jobs activos. Esperá a que termine el trabajo activo y reintentá.']);
    const access = await currentRunnerProjectAccess(db, job, transaction);
    if (!access) throw new RunnerDispatchError('preflight', ['El proyecto del issue debe declarar repos autorizados en este workspace; el contexto de revisión debe incluir todos los repos actuales del proyecto y sus PRs.']);
    const envelope = { ...unsigned, projectId: access.projectId, protocolVersion: 2 as const };
    job = { ...envelope, signature: signRunnerJob(envelope, privateKey) };
    if (taskDispatch) {
      // Budget writes are last: Firestore requires every read before writes.
      // Aborting any validation/signing/commit leaves no cooldown or spend.
      const budget = await checkWorkspaceDispatchBudget(transaction, db, job.workspaceId);
      if (!budget.allowed) throw new RunnerDispatchError('budget', [budget.reason === 'paused'
        ? 'Los agentes están pausados. Reanudalos en Ajustes para reintentar.'
        : 'Se alcanzó el límite diario de dispatches o costo del workspace. Revisá el presupuesto en Ajustes o reintentá al día siguiente.']);
      transaction.update(issueRef, {
        'agent.dispatchedAt': issuedAt, 'agent.dispatchedTo': job.agentId,
        'agent.dispatchFailure': FieldValue.delete(), 'agent.blockedReason': FieldValue.delete(), 'agent.state': 'idle',
      });
      transaction.create(db.collection('agent_runs').doc(job.id), {
        id: job.id, issueId: job.issueId, workspaceId: job.workspaceId, agentId: job.agentId,
        role: 'dev', mode: 'task', repo: job.repoFullName, runnerId: job.runnerId, startedAt: issuedAt, date: todayKey(),
      });
    }
    transaction.update(db.collection('runners').doc(job.runnerId), { lastDispatchAt: issuedAt });
    transaction.update(agentRef, { runnerJobDispatchAt: issuedAt });
    transaction.create(db.collection('runner_jobs').doc(job.id), { ...job, status: 'pending', createdAt: issuedAt });
  });
  return job;
}
