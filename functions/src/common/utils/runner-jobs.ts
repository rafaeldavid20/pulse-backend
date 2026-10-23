import { cleanUndefined } from './clean';
import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { sign, createHash } from 'crypto';
import { activityLease } from './run-activity';
import { activeDevelopmentJob, hasExecutionLease } from './development-execution';
import { nanoid } from 'nanoid';
import { publicationPayload, PublicationTarget, validBranch } from './runner-publication';
import { isTransientRunnerPreflight, runnerPreflight } from './runner-preflight';
import { currentRunnerProjectAccess } from './project-repos';
import { DISPATCH_COOLDOWN_MS, RunnerDispatchError } from './dispatch-failure';
import { checkWorkspaceDispatchBudget, todayKey } from './dispatch-counter';
import { assertHumanReworkRequester, reworkRepositories, returnedDevelopmentReview } from './human-rework';
import { checkIssueRunBudget } from './issue-run-budget';
import { assertReviewRequest } from './review-request';
import { hasCompleteDevSelfCheck } from './dev-self-check';
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

export type DispatchReservation = { mode: 'review'; attempt: number; refs: string; context?: string; requestedBy?: string; headScope?: Array<{repoFullName:string;prNumber:number;headSha:string}>; partial?: boolean } | boolean | { mode: 'handoff'; requestedAt: string } | { mode: 'rework'; attempt: number; requestedBy?: string; comment?: string; requestId?: string } | { mode: 'task'; requestedBy: string; requestId: string };

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
    const humanRequest = reservation && reservation !== true && (reservation.mode === 'rework' || reservation.mode === 'task') && reservation.requestedBy ? reservation : undefined;
    const returnedReview = humanRequest?.mode === 'rework' ? returnedDevelopmentReview(issue) : undefined;
    const developmentReview = returnedReview || issue?.review;
    const requester = humanRequest?.requestedBy;
    const requestRef = humanRequest && 'requestId' in humanRequest && humanRequest.requestId
      ? db.collection('development_requests').doc(createHash('sha256').update(`${job.issueId}:${requester}:${humanRequest.requestId}`).digest('hex')) : undefined;
    if (humanRequest) {
      const member = await transaction.get(db.collection('members').doc(`${job.workspaceId}_${requester}`));
      const callerAgent = await transaction.get(db.collection('agents').doc(requester!));
      if (!issue || issue.workspaceId !== job.workspaceId || callerAgent.exists || agent.data()!.role !== 'dev' || !agent.data()!.enabled) throw new Error('La solicitud humana ya no está autorizada.');
      assertHumanReworkRequester(requester!, member.data(), agent.data(), issue);
      // Return the original receipt even after completion, expiry or a lost HTTP response.
      if (requestRef) {
        const receipt = await transaction.get(requestRef);
        if (receipt.exists) {
          const previous = await transaction.get(db.collection('runner_jobs').doc(receipt.data()!.jobId));
          if (!previous.exists) throw new Error('No se encontró el job de la solicitud.');
          job = previous.data() as RunnerJob;
          return;
        }
      }
    }
    const issueJobs = humanRequest ? await transaction.get(db.collection('runner_jobs').where('issueId', '==', job.issueId)) : undefined;
    const issueRuns = humanRequest ? await transaction.get(db.collection('agent_runs').where('issueId', '==', job.issueId)) : undefined;
    if (humanRequest && (issueJobs!.docs.some(s => activeDevelopmentJob(s.data())) || hasExecutionLease(issue!, issueRuns!.docs.map(s => s.data())))) {
      throw new RunnerDispatchError('enqueue', ['El issue tiene una ejecución viva o un job en cola. Esperá a que termine; consultá el diagnóstico del Runner.'], true);
    }
    if (reservation === true) {
      if (!issue || issue.status !== 'todo' || (issue.execution?.agentId || issue.assigneeId) !== job.agentId || issue.agent?.state === 'claimed') {
        throw new RunnerDispatchError('enqueue', ['La issue ya no está disponible para este dispatch.'], true);
      }
      if (issue.agent?.dispatchedTo === job.agentId && Date.now() - Date.parse(issue.agent.dispatchedAt || '') < DISPATCH_COOLDOWN_MS) {
        throw new RunnerDispatchError('enqueue', ['La issue ya tiene un dispatch reciente.'], true);
      }
    }
    if (reservation && reservation !== true && reservation.mode !== 'review') {
      if (!issue || ['done', 'canceled'].includes(issue.status) || (issue.execution?.agentId || issue.assigneeId) !== job.agentId || (!humanRequest && issue.agent?.state === 'claimed')) {
        throw new RunnerDispatchError('enqueue', ['La issue ya no está disponible para este dispatch.'], true);
      }
      if (reservation.mode === 'handoff') {
        const entry = (issue.pendingRepoWork || []).find((e: any) => e.repoFullName === job.repoFullName);
        if (job.mode !== 'handoff' || !entry || entry.requestedAt !== reservation.requestedAt || entry.dispatchedAt) {
          throw new RunnerDispatchError('enqueue', ['El traspaso ya fue enviado o cambió.'], true);
        }
      } else if (reservation.mode === 'task') {
        if (job.mode !== 'task' || !['todo', 'in_progress'].includes(issue.status) || issue.review?.state || (issue.gitRefs || [issue.git]).some((ref: any) => ref?.prNumber)) throw new Error('El issue requiere resolver su revisión o PR existente antes de iniciar desarrollo.');
      } else if (job.mode !== 'rework' || developmentReview?.state !== 'changes_requested' || developmentReview.attempt !== reservation.attempt || (!humanRequest && issue.review.reworkDispatchedForAttempt === reservation.attempt)) {
        throw new RunnerDispatchError('enqueue', ['El intento de retrabajo ya fue enviado o cambió.'], true);
      }
    }
    if (humanRequest) {
      if (!['in_review', 'in_progress', 'todo'].includes(issue!.status)) throw new Error('Reabrí el issue antes de ejecutar desarrollo.');
      if ((issue!.pendingRepoWork || []).some((entry: any) => !entry.dispatchedAt)) throw new Error('El issue tiene un traspaso pendiente.');
      if (humanRequest.mode === 'rework') {
        const qaId = developmentReview.reviewerId || developmentReview.dispatchedTo;
        const qa = qaId ? await transaction.get(db.collection('agents').doc(qaId)) : undefined;
        if (humanRequest.attempt >= (qa?.data()?.maxReviewAttempts ?? 2)) throw new Error('No quedan intentos de revisión disponibles. Usá la recuperación de revisión escalada.');
      }
      const issueBudget = await checkIssueRunBudget(db, job.workspaceId, job.issueId, transaction);
      if (!issueBudget.withinBudget) throw new Error('El issue alcanzó su límite de ejecuciones o costo. Revisá los límites con un administrador.');
      const agentJobs = await transaction.get(db.collection('runner_jobs').where('agentId', '==', job.agentId));
      const occupied = new Set(agentJobs.docs.filter(s => activeDevelopmentJob(s.data()) && s.data().issueId !== job.issueId).map(s => s.data().issueId));
      const agentRuns = await transaction.get(db.collection('agent_runs').where('agentId', '==', job.agentId));
      for (const snap of agentRuns.docs) if (snap.data().issueId !== job.issueId && activityLease(snap.data())) occupied.add(snap.data().issueId);
      const agentIssues = await transaction.get(db.collection('issues').where('workspaceId', '==', job.workspaceId));
      for (const snap of agentIssues.docs) {
        const other = snap.data();
        if (snap.id !== job.issueId && (other.execution?.agentId || other.assigneeId) === job.agentId && hasExecutionLease(other, [])) occupied.add(snap.id);
      }
      if (occupied.size >= (agent.data()!.maxConcurrentIssues ?? 1)) throw new Error('El agente alcanzó su capacidad de issues activos. Esperá a que termine otra ejecución.');
    }
    const reviewRequest = reservation && reservation !== true && reservation.mode === 'review' ? reservation : undefined;
    if (reviewRequest) {
      if (job.mode !== 'review' || agent.data()!.role !== 'qa' || !agent.data()!.enabled) throw new Error('El agente QA ya no está habilitado.');
      if (!reviewRequest.requestedBy && reviewRequest.context && issue?.review?.dispatchedContext === reviewRequest.context) throw new RunnerDispatchError('enqueue', ['Este contexto QA ya fue despachado.'], true);
      assertReviewRequest(issue, reviewRequest.attempt, reviewRequest.refs, !!reviewRequest.requestedBy, agent.data()!.maxReviewAttempts ?? 2);
      if (!reviewRequest.requestedBy) {
        const project = issue?.projectId ? (await transaction.get(db.collection('projects').doc(issue.projectId))).data() : null;
        const checkJob = issue?.devSelfCheckJobId ? (await transaction.get(db.collection('runner_jobs').doc(issue.devSelfCheckJobId))).data() : null;
        if (!checkJob || checkJob.status !== 'completed' || checkJob.issueId !== job.issueId || !hasCompleteDevSelfCheck(issue, project, checkJob.id, checkJob.deliveredAt, reviewRequest.headScope?.map(h => ({repo: h.repoFullName, headSha: h.headSha})))) throw new RunnerDispatchError('enqueue', ['QA automático bloqueado: la autoverificación falta, está incompleta o no corresponde a los HEADs actuales.']);
      }
      if (reviewRequest.requestedBy && (!reviewRequest.headScope?.length || reviewRequest.headScope.some(h => !/^[a-f0-9]{40}$/.test(h.headSha)))) throw new Error('La solicitud manual debe quedar vinculada a los HEADs verificados. Volvé a solicitar QA.');
      if (reviewRequest.requestedBy) {
        const member = await transaction.get(db.collection('members').doc(`${job.workspaceId}_${reviewRequest.requestedBy}`));
        const callerAgent = await transaction.get(db.collection('agents').doc(reviewRequest.requestedBy));
        if (!member.exists || member.data()?.isAgent || callerAgent.exists) throw new Error('Solo un miembro humano del workspace puede solicitar una revisión manual.');
      }
      if (!reviewRequest.requestedBy && !issue!.qaAssigneeId && !agent.data()!.autonomousMode) throw new RunnerDispatchError('preflight', ['El QA ya no tiene habilitado el modo autónomo.']);
      if ((issue!.execution?.agentId || issue!.assigneeId) === job.agentId || (issue!.qaAssigneeId && issue!.qaAssigneeId !== job.agentId)) throw new Error('Cambió el agente QA asignado. Revisá la asignación y volvé a solicitar QA.');
      if (!reviewRequest.requestedBy && issue!.review?.dispatchedTo === job.agentId && Date.now() - Date.parse(issue!.review.dispatchedAt || '') < DISPATCH_COOLDOWN_MS) throw new RunnerDispatchError('enqueue', ['La issue ya tiene un dispatch QA reciente.'], true);
      const issueBudget = await checkIssueRunBudget(db, job.workspaceId, job.issueId, transaction);
      if (!issueBudget.withinBudget) throw new Error('La issue alcanzó su límite de ejecuciones o costo. Revisá el presupuesto antes de solicitar QA.');
      const issueJobs = await transaction.get(db.collection('runner_jobs').where('issueId', '==', job.issueId));
      if (issueJobs.docs.some(snap => ['pending', 'delivered'].includes(snap.data().status) && (!Number.isFinite(Date.parse(snap.data().expiresAt)) || Date.parse(snap.data().expiresAt) > Date.now()))) throw new RunnerDispatchError('enqueue', ['La issue espera a que termine el job activo.'], false, true);
    }
    const runner = await transaction.get(db.collection('runners').doc(job.runnerId));
    const preflight = runnerPreflight({ ...agent.data(), id: job.agentId }, runner.exists ? { ...runner.data(), id: job.runnerId } : null, job.workspaceId, contextRepos, job.mode, Date.now(), true, !!input.recoveryOf);
    if (!preflight.ready) throw new RunnerDispatchError('preflight', preflight.problems.map((problem) => `${problem.message} ${problem.action}`), false, job.mode === 'review' && isTransientRunnerPreflight(preflight, runner.data()));
    const active = await transaction.get(db.collection('runner_jobs').where('runnerId', '==', job.runnerId));
    const activeJobs = active.docs.filter((snap) => ['pending', 'delivered'].includes(snap.data().status) && (!Number.isFinite(Date.parse(snap.data().expiresAt)) || Date.parse(snap.data().expiresAt) > Date.now()));
    if (reservation && activeJobs.some((snap) => snap.data().issueId === job.issueId && snap.data().agentId === job.agentId)) {
      throw new RunnerDispatchError('enqueue', ['La issue ya tiene un job activo.'], true);
    }
    const count = activeJobs.length;
    if (count >= (runner.data()!.maxConcurrentJobs || 1)) throw new RunnerDispatchError('enqueue', ['El Runner ya alcanzó su capacidad de jobs activos.'], false, true);
    const access = await currentRunnerProjectAccess(db, job, transaction);
    if (!access) throw new RunnerDispatchError('preflight', ['El proyecto del issue debe declarar repos autorizados en este workspace; el contexto de revisión debe incluir todos los repos actuales del proyecto y sus PRs.']);
    if (reservation && reservation !== true && reservation.mode === 'rework' && !input.recoveryOf) {
      const currentRepos = reworkRepositories(issue, access.repos, job.repoFullName);
      if (currentRepos.join(',') !== contextRepos.join(',')) throw new RunnerDispatchError('enqueue', ['Los PRs del issue cambiaron; volvé a solicitar la corrección.']);
    }
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
      // A publication retry is not a human-authorized partial review. Keep all
      // recovered work draft so it cannot silently start automatic QA.
      prPublicationMode = data?.prPublicationMode === 'ready' ? 'draft' : (data?.prPublicationMode ?? 'draft');
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
    try {
      job = { ...envelope, signature: signRunnerJob(envelope, privateKey) };
    } catch {
      throw new RunnerDispatchError('enqueue', ['No se pudo firmar el job. Revisá la configuración de firma del backend y reintentá; no se reservó ni consumió presupuesto.']);
    }
    if (reservation) {
      // Budget writes are last: Firestore requires every read before writes.
      // Aborting any validation/signing/commit leaves no cooldown or spend.
      const budget = await checkWorkspaceDispatchBudget(transaction, db, job.workspaceId);
      if (!budget.allowed) throw new RunnerDispatchError('budget', [budget.reason === 'paused'
        ? 'Los agentes están pausados. Reanudalos en Ajustes para reintentar.'
        : 'Se alcanzó el límite diario de dispatches o costo del workspace. Revisá el presupuesto en Ajustes o reintentá al día siguiente.']);
      let modeMarks: Record<string, any> = {};
      if (reviewRequest) {
        modeMarks = {
          'review.dispatchedAt': issuedAt, 'review.dispatchedTo': job.agentId,
          ...(reviewRequest.context ? { 'review.dispatchedContext': reviewRequest.context } : {}),
          'review.dispatchError': FieldValue.delete(), 'review.dispatchPending': FieldValue.delete(), 'review.queuedJobId': job.id,
          ...(reviewRequest.requestedBy ? { 'review.manualRequest': {
            jobId: job.id, requestedBy: reviewRequest.requestedBy,
            requestedAt: issuedAt, expiresAt, attempt: reviewRequest.attempt + 1,
            headScope: reviewRequest.headScope, partial: !!reviewRequest.partial,
          } } : {}),
        };
      } else if (reservation !== true && reservation.mode === 'handoff') {
        modeMarks = { pendingRepoWork: issue!.pendingRepoWork.map((e: any) => e.repoFullName === job.repoFullName ? { ...e, dispatchedAt: issuedAt } : e) };
      } else if (reservation !== true && reservation.mode === 'rework') {
        modeMarks = returnedReview
          ? { review: cleanUndefined({ ...returnedReview, reworkDispatchedAt: issuedAt, reworkDispatchedForAttempt: reservation.attempt }) }
          : { 'review.reworkDispatchedAt': issuedAt, 'review.reworkDispatchedForAttempt': reservation.attempt };
      }
      transaction.update(issueRef, {
        ...modeMarks,
        ...(humanRequest ? { 'agent.claimedAt': FieldValue.delete(), 'agent.claimedBy': FieldValue.delete(), status: 'in_progress', 'git.lastSyncedStatus': 'in_progress', updatedAt: issuedAt, updatedBy: humanRequest.requestedBy } : {}),
        ...(reviewRequest ? { updatedAt: issuedAt } : { 'agent.dispatchedAt': issuedAt, 'agent.dispatchedTo': job.agentId,
        'agent.dispatchFailure': FieldValue.delete(), 'agent.blockedReason': FieldValue.delete(), 'agent.state': 'idle' }),
      });
      transaction.create(db.collection('agent_runs').doc(job.id), {
        id: job.id, issueId: job.issueId, workspaceId: job.workspaceId, agentId: job.agentId,
        role: reviewRequest ? 'qa' : 'dev', mode: job.mode,
        ...(reviewRequest ? {
          reviewAttempt: reviewRequest.attempt + 1,
          requestSource: reviewRequest.requestedBy ? 'manual' : 'automatic',
          ...(reviewRequest.requestedBy ? { requestedBy: reviewRequest.requestedBy } : {}),
        } : {}),
        ...(humanRequest ? { requestedBy: humanRequest.requestedBy } : {}),
        ...(reservation !== true && reservation.mode === 'rework' ? { reviewAttempt: reservation.attempt } : {}),
        repo: job.repoFullName, runnerId: job.runnerId, startedAt: issuedAt, date: todayKey(),
      });
    }
    if (humanRequest) {
      if (requestRef) transaction.create(requestRef, { issueId: job.issueId, workspaceId: job.workspaceId, requestedBy: requester, jobId: job.id, mode: job.mode, createdAt: issuedAt, ...(issue!.agent?.state === 'claimed' ? { recoveredClaim: { state: issue!.agent.state, ...(issue!.agent.claimedBy ? { claimedBy: issue!.agent.claimedBy } : {}), ...(issue!.agent.claimedAt ? { claimedAt: issue!.agent.claimedAt } : {}) } } : {}) });
      for (const snap of issueJobs!.docs) {
        if (['pending', 'delivered'].includes(snap.data().status)) transaction.update(snap.ref, { status: 'expired', expiredAt: issuedAt });
      }
      const commentId = `cmt-${job.id}`;
      transaction.create(db.collection('comments').doc(commentId), {
        id: commentId, workspaceId: job.workspaceId, issueId: job.issueId, authorId: humanRequest.requestedBy,
        body: humanRequest.mode === 'rework' ? `**Corrección solicitada al agente**: se retoma el intento ${humanRequest.attempt} en los mismos PRs; se conservan el modo de QA y los límites.\n\n${humanRequest.comment || ''}` : '**Desarrollo solicitado al agente**: se conservan el responsable, ejecutor y los límites.',
        source: 'web', createdAt: issuedAt,
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
