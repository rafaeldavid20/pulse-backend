import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { sign } from 'crypto';
import { nanoid } from 'nanoid';
import { publicationPayload, PublicationTarget, validBranch } from './runner-publication';
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
  return (job.protocolVersion === 3 ? [...fields, 3, job.projectId, publicationPayload(job.publicationTargets), job.recoveryOf || '', ...(job.prPublicationMode !== undefined ? [job.prPublicationMode] : [])] : job.protocolVersion === 2 ? [...fields, 2, job.projectId] : fields).join('.');
}

export function signRunnerJob(job: Omit<RunnerJob, 'signature'>, privateKey: string): string {
  return base64url(sign(null, Buffer.from(runnerJobPayload(job)), privateKey));
}

export type DispatchReservation = boolean | { mode: 'handoff'; requestedAt: string } | { mode: 'rework'; attempt: number };

/** Crea un trabajo de vida corta. El documento no contiene ninguna credencial de proveedor. */
export async function enqueueRunnerJob(
  db: Firestore,
  input: Omit<RunnerJob, 'id' | 'issuedAt' | 'expiresAt' | 'signature' | 'signatureAlgorithm' | 'signingKeyId'>,
  privateKey: string,
  signingKeyId = 'runner-job-v1',
  reservation: DispatchReservation = false,
): Promise<RunnerJob> {
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  const contextRepos = [...new Set(input.contextRepos || [input.repoFullName])].sort();
  // The caller cannot override the authenticated agent setting.
  const { prPublicationMode: _ignoredMode, ...dispatchInput } = input;
  const unsigned = { id: `rjob-${nanoid(12)}`, ...dispatchInput, contextRepos, issuedAt, expiresAt, signatureAlgorithm: 'ed25519' as const, signingKeyId };
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
    const issue = reservation ? (await transaction.get(issueRef)).data() : undefined;
    if (reservation === true) {
      if (!issue || issue.status !== 'todo' || (issue.execution?.agentId || issue.assigneeId) !== job.agentId || issue.agent?.state === 'claimed') {
        throw new RunnerDispatchError('enqueue', ['La issue ya no está disponible para este dispatch.'], true);
      }
      if (issue.agent?.dispatchedTo === job.agentId && Date.now() - Date.parse(issue.agent.dispatchedAt || '') < DISPATCH_COOLDOWN_MS) {
        throw new RunnerDispatchError('enqueue', ['La issue ya tiene un dispatch reciente.'], true);
      }
    }
    if (reservation && reservation !== true) {
      if (!issue || ['done', 'canceled'].includes(issue.status) || (issue.execution?.agentId || issue.assigneeId) !== job.agentId || issue.agent?.state === 'claimed') {
        throw new RunnerDispatchError('enqueue', ['La issue ya no está disponible para este dispatch.'], true);
      }
      if (reservation.mode === 'handoff') {
        const entry = (issue.pendingRepoWork || []).find((e: any) => e.repoFullName === job.repoFullName);
        if (job.mode !== 'handoff' || !entry || entry.requestedAt !== reservation.requestedAt || entry.dispatchedAt) {
          throw new RunnerDispatchError('enqueue', ['El traspaso ya fue enviado o cambió.'], true);
        }
      } else if (job.mode !== 'rework' || issue.review?.state !== 'changes_requested' || issue.review.attempt !== reservation.attempt || issue.review.reworkDispatchedForAttempt === reservation.attempt) {
        throw new RunnerDispatchError('enqueue', ['El intento de retrabajo ya fue enviado o cambió.'], true);
      }
    }
    const runner = await transaction.get(db.collection('runners').doc(job.runnerId));
    const preflight = runnerPreflight({ ...agent.data(), id: job.agentId }, runner.exists ? { ...runner.data(), id: job.runnerId } : null, job.workspaceId, contextRepos, job.mode, Date.now(), true, !!input.recoveryOf);
    if (!preflight.ready) throw new RunnerDispatchError('preflight', preflight.problems.map((problem) => `${problem.message} ${problem.action}`));
    const active = await transaction.get(db.collection('runner_jobs').where('runnerId', '==', job.runnerId));
    const activeJobs = active.docs.filter((snap) => ['pending', 'delivered'].includes(snap.data().status) && (!Number.isFinite(Date.parse(snap.data().expiresAt)) || Date.parse(snap.data().expiresAt) > Date.now()));
    if (reservation && activeJobs.some((snap) => snap.data().issueId === job.issueId && snap.data().agentId === job.agentId)) {
      throw new RunnerDispatchError('enqueue', ['La issue ya tiene un job activo.'], true);
    }
    const count = activeJobs.length;
    if (count >= (runner.data()!.maxConcurrentJobs || 1)) throw new RunnerDispatchError('enqueue', ['El Runner ya alcanzó su capacidad de jobs activos. Esperá a que termine el trabajo activo y reintentá.']);
    const access = await currentRunnerProjectAccess(db, job, transaction);
    if (!access) throw new RunnerDispatchError('preflight', ['El proyecto del issue debe declarar repos autorizados en este workspace; el contexto de revisión debe incluir todos los repos actuales del proyecto y sus PRs.']);
    let prPublicationMode = agent.data()?.prPublicationMode ?? 'draft';
    let publicationTargets: PublicationTarget[] | undefined;
    const localApp = runner.data()?.readiness?.jobProtocolVersion === 3 && job.mode !== 'review';
    if (localApp) {
      const issueData = (await transaction.get(issueRef)).data()!;
      publicationTargets = (input.recoveryOf ? input.publicationTargets!.map(t => t.repo) : contextRepos).map((repo) => {
        const binding = runner.data()!.readiness.githubApps?.find((e: any) => e.projectId === access.projectId && e.repo === repo && e.ready);
        if (!binding) throw new RunnerDispatchError('preflight', [`Configurá y verificá una GitHub App local para ${repo} en el proyecto ${access.projectId}.`]);
        const original = input.publicationTargets?.find(t => t.repo === repo);
        const ref = (issueData.gitRefs || []).find((r: any) => r.repoFullName === repo) || (issueData.git?.repoFullName === repo ? issueData.git : null);
        const issuePrefix = /^[A-Za-z]{2,10}-\d+$/.test(issueData.identifier || '') ? `${issueData.identifier.toLowerCase()}-` : '';
        const branch = input.recoveryOf ? original?.branch : job.mode === 'rework' ? ref?.branch : `pul/${issuePrefix}${job.id}`;
        if (!validBranch(branch) || !branch.startsWith('pul/') || !validBranch(original?.base || binding.base)) throw new Error('Falta la rama autorizada para retrabajo/publicación.');
        return { repo, branch, base: original?.base || binding.base, appId: binding.appId, installationId: binding.installationId, slug: binding.slug, ...(original?.sha ? { sha: original.sha } : {}) };
      });
    }
    if (input.recoveryOf) {
      const original = await transaction.get(db.collection('runner_jobs').doc(input.recoveryOf));
      const data = original.data();
      prPublicationMode = data?.prPublicationMode ?? 'draft';
      if (!data || data.runnerId !== job.runnerId || data.workspaceId !== job.workspaceId || data.issueId !== job.issueId || data.projectId !== access.projectId || data.agentId !== job.agentId || data.retriedByJobId || data.publication?.execution !== 'completed' || !['failed', 'canceled', 'expired'].includes(data.status) || !publicationTargets?.length) throw new Error('La publicación original ya fue reintentada o no es recuperable.');
      if (publicationTargets.length !== data.publication.repositories.length || new Set(publicationTargets.map(t => t.repo)).size !== publicationTargets.length || contextRepos.join(',') !== [...new Set<string>(data.contextRepos || [data.repoFullName])].sort().join(',')) throw new Error('El reintento debe conservar todo el alcance original.');
      for (const target of publicationTargets) {
        const entry = data.publication.repositories.find((e: any) => e.repo === target.repo);
        const previous = data.publicationTargets.find((e: any) => e.repo === target.repo);
        if (!entry || entry.sha !== target.sha || entry.branch !== target.branch || previous.base !== target.base || previous.appId !== target.appId || previous.installationId !== target.installationId || previous.slug !== target.slug) throw new Error('La identidad o alcance de publicación cambió.');
      }
    }
    if (!['draft', 'ready'].includes(prPublicationMode)) throw new Error('Modo de publicación de PR inválido.');
    const supportsPublicationMode = localApp && runner.data()?.readiness?.prPublicationModeVersion === 1;
    if (job.mode !== 'review' && prPublicationMode === 'ready' && !supportsPublicationMode) throw new RunnerDispatchError('preflight', ['Actualizá @pulsehub/runner y reiniciá el servicio para publicar PR listos para revisión.']);
    const envelope = { ...(supportsPublicationMode ? { prPublicationMode } : {}), ...unsigned, projectId: access.projectId, protocolVersion: localApp ? 3 as const : 2 as const, ...(publicationTargets ? { publicationTargets } : {}) };
    job = { ...envelope, signature: signRunnerJob(envelope, privateKey) };
    if (reservation) {
      // Budget writes are last: Firestore requires every read before writes.
      // Aborting any validation/signing/commit leaves no cooldown or spend.
      const budget = await checkWorkspaceDispatchBudget(transaction, db, job.workspaceId);
      if (!budget.allowed) throw new RunnerDispatchError('budget', [budget.reason === 'paused'
        ? 'Los agentes están pausados. Reanudalos en Ajustes para reintentar.'
        : 'Se alcanzó el límite diario de dispatches o costo del workspace. Revisá el presupuesto en Ajustes o reintentá al día siguiente.']);
      const modeMarks = reservation === true ? {} : reservation.mode === 'handoff'
        ? { pendingRepoWork: issue!.pendingRepoWork.map((e: any) => e.repoFullName === job.repoFullName ? { ...e, dispatchedAt: issuedAt } : e) }
        : { 'review.reworkDispatchedAt': issuedAt, 'review.reworkDispatchedForAttempt': reservation.attempt };
      transaction.update(issueRef, {
        ...modeMarks,
        'agent.dispatchedAt': issuedAt, 'agent.dispatchedTo': job.agentId,
        'agent.dispatchFailure': FieldValue.delete(), 'agent.blockedReason': FieldValue.delete(), 'agent.state': 'idle',
      });
      transaction.create(db.collection('agent_runs').doc(job.id), {
        id: job.id, issueId: job.issueId, workspaceId: job.workspaceId, agentId: job.agentId,
        role: 'dev', mode: job.mode, ...(reservation !== true && reservation.mode === 'rework' ? { reviewAttempt: reservation.attempt } : {}), repo: job.repoFullName, runnerId: job.runnerId, startedAt: issuedAt, date: todayKey(),
      });
    }
    if (input.recoveryOf) transaction.update(db.collection('runner_jobs').doc(input.recoveryOf), { retriedByJobId: job.id, retryRequestedAt: issuedAt });
    if (input.recoveryOf) transaction.create(db.collection('agent_runs').doc(job.id), {id: job.id, workspaceId: job.workspaceId, issueId: job.issueId, agentId: job.agentId, runnerId: job.runnerId, repo: job.repoFullName, role: 'dev', mode: job.mode, startedAt: issuedAt, date: todayKey(), publicationOnly: true});
    transaction.update(db.collection('runners').doc(job.runnerId), { lastDispatchAt: issuedAt });
    transaction.update(agentRef, { runnerJobDispatchAt: issuedAt });
    transaction.create(db.collection('runner_jobs').doc(job.id), { ...job, status: 'pending', createdAt: issuedAt });
  });
  return job;
}
