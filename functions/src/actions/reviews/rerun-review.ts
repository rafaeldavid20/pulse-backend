import { runnerPreflight } from '../../common/utils/runner-preflight';
import { getFirestore, Transaction, FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { IssueReview } from '../../common/domain.generated';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import { checkWorkspaceDispatchBudget, todayKey } from '../../common/utils/dispatch-counter';
import { dispatchRepositoryEvent } from '../../github/client';
import { enqueueRunnerJob } from '../../common/utils/runner-jobs';
import { isRunnerAvailable } from '../../common/utils/runner-availability';
import { runnerJobSigningPrivateKey } from '../../common/secrets';

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

interface ReviewablePr {
  repoFullName: string;
  prNumber: number;
}

/** Mismo criterio que `qaDispatchTrigger` (D4): todos los PRs abiertos, sin traspasos pendientes. */
function reviewablePrs(issue: FirebaseFirestore.DocumentData): ReviewablePr[] | null {
  if ((issue.pendingRepoWork || []).length > 0) return null;
  const refs: any[] =
    Array.isArray(issue.gitRefs) && issue.gitRefs.length > 0
      ? issue.gitRefs
      : issue.git?.repoFullName
        ? [issue.git]
        : [];
  if (refs.length === 0) return null;
  if (!refs.every((r) => r?.prNumber !== undefined && r.prState === 'open')) return null;
  return refs.map((r) => ({ repoFullName: r.repoFullName, prNumber: r.prNumber }));
}

/**
 * `reviews.rerun` (D7): "Re-ejecutar QA" — un humano vuelve a despachar la
 * revisión a pedido, en vez de esperar a que `qaDispatchTrigger` (D4) lo haga
 * solo. A diferencia de ese trigger automático, acá se pisan a propósito sus
 * dos guardas pensadas para dispatches automáticos: el cooldown
 * anti-doble-disparo y el anti-ping-pong por SHA sin cambios — un click es,
 * por definición, un pedido explícito y único, no un loop. El circuit
 * breaker diario y el kill switch (`checkWorkspaceDispatchBudget`, D8/TES-153)
 * sí se respetan: protegen el costo del workspace sin importar quién dispare,
 * y `agentsPaused` no puede sortearse con un click.
 *
 * Si todavía no existe un intento (por ejemplo, porque no había un agente QA
 * elegible al entrar en revisión), se puede despachar después de corregir la
 * configuración. Si el intento actual sigue `running` (el caso típico: un run que no
 * arrancó o se colgó antes de que el barrido de 30min lo escale), se
 * re-despacha ESE MISMO intento — no consume uno nuevo, y el próximo
 * `pulse_next_review` del agente QA lo retoma vía la rama `resumingSelf` de
 * `reviews.start`. Si el intento anterior ya cerró (`approved`/
 * `changes_requested`/`stale`) pero el issue sigue `in_review`, se despacha
 * como si fuera uno nuevo (`reviews.start` lo archiva en `history` al
 * reclamarlo), sujeto al mismo tope `maxReviewAttempts` que el dispatch
 * automático.
 */
export class ReviewsRerunAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.rerun', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.issueId) {
      throw new Error('Parámetro requerido faltante: issueId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    if (issue.status !== 'in_review') {
      throw new Error(`El issue '${issue.identifier}' no está en revisión (status '${issue.status}'), no hay nada que re-ejecutar.`);
    }

    const review = issue.review as IssueReview | undefined;
    if (review?.state === 'needs_human') {
      throw new Error('La revisión está escalada a needs_human: usá "Devolver al agente" o "Aprobar igual" en vez de re-ejecutar.');
    }

    const prs = reviewablePrs(issue);
    if (!prs) {
      throw new Error(`El issue '${issue.identifier}' no tiene todos sus PRs abiertos (o hay trabajo pendiente en otro repo), no se puede re-ejecutar la revisión.`);
    }

    const { repoFullName } = await resolveIssueRepo(db, { ...issue, id: data.issueId }, { agentId: issue.execution?.agentId || issue.assigneeId });
    if (!repoFullName) {
      throw new Error(`No se pudo resolver el repo del issue '${issue.identifier}'.`);
    }

    const qaSnap = await db
      .collection('agents')
      .where('workspaceId', '==', issue.workspaceId)
      .where('role', '==', 'qa')
      .where('enabled', '==', true)
      .get();
    const assignedQa = issue.qaAssigneeId ? qaSnap.docs.find((d) => d.id === issue.qaAssigneeId) : undefined;
    if (issue.qaAssigneeId && !assignedQa) {
      throw new Error('El agente QA asignado ya no está habilitado o no pertenece a este workspace.');
    }
    const executionAgentId = issue.execution?.agentId || issue.assigneeId;
    if (assignedQa && (assignedQa.id === executionAgentId || assignedQa.data().reviewRepo !== repoFullName || assignedQa.data().archivedAt)) {
      throw new Error(`El agente QA asignado no está configurado para revisar '${repoFullName}'.`);
    }
    const qaCandidates = assignedQa
      ? [assignedQa]
      : qaSnap.docs.filter((d) => d.data().autonomousMode === true && d.id !== executionAgentId && !d.data().archivedAt && d.data().reviewRepo === repoFullName);
    if (qaCandidates.length === 0) {
      throw new Error(`No hay un agente QA habilitado con reviewRepo '${repoFullName}' para re-ejecutar la revisión.`);
    }
    const reviewRepos = [...new Set(prs.map((pr) => pr.repoFullName))];
    let qaDoc: (typeof qaSnap.docs)[number] | undefined;
    let runner: FirebaseFirestore.DocumentData | undefined;
    for (const candidate of qaCandidates.filter((item) => !!item.data().runnerId)) {
      const candidateRunnerSnap = await db.collection('runners').doc(candidate.data().runnerId).get();
      if (!candidateRunnerSnap.exists || candidateRunnerSnap.data()!.workspaceId !== issue.workspaceId || !isRunnerAvailable(candidateRunnerSnap.data()!)) continue;
      const candidateRunner = candidateRunnerSnap.data()!;
      if (!runnerPreflight({ ...candidate.data(), id: candidate.id }, { ...candidateRunner, id: candidateRunnerSnap.id }, issue.workspaceId, reviewRepos, 'review', Date.now(), true).ready) continue;
      const jobs = await db.collection('runner_jobs').where('runnerId', '==', candidateRunner.id).get();
      const active = jobs.docs.filter((doc) => {
        const job = doc.data();
        if (!['pending', 'delivered'].includes(job.status)) return false;
        const expiresAt = new Date(job.expiresAt).getTime();
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      }).length;
      if (active >= (candidateRunner.maxConcurrentJobs || 1)) continue;
      qaDoc = candidate;
      runner = candidateRunner;
      break;
    }
    // QA sin Runner sigue disponible vía GitHub Actions cuando ningún Runner
    // asociado puede aceptar esta revisión ahora.
    qaDoc ||= qaCandidates.find((candidate) => !candidate.data().runnerId);
    if (!qaDoc) throw new Error(`No hay un agente QA con Runner disponible para re-ejecutar la revisión de '${repoFullName}'.`);
    const qaAgent = qaDoc.data();
    const qaAgentId = qaDoc.id;
    const runnerId = qaAgent.runnerId as string | undefined;
    if (runnerId) {
      const runnerSnap = await db.collection('runners').doc(runnerId).get();
      if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== issue.workspaceId || !isRunnerAvailable(runnerSnap.data()!)) throw new Error('El Pulse Runner del agente QA dejó de estar disponible o ya no cubre todos los repos.');
      runner = runnerSnap.data()!;
      const preflight = runnerPreflight({ ...qaAgent, id: qaAgentId }, { ...runner, id: runnerId }, issue.workspaceId, reviewRepos, 'review', Date.now(), true);
      if (!preflight.ready) throw new Error(preflight.problems.map((problem) => `${problem.message} ${problem.action}`).join(' '));
      const jobs = await db.collection('runner_jobs').where('runnerId', '==', runnerId).get();
      const active = jobs.docs.filter((doc) => {
        const job = doc.data();
        if (!['pending', 'delivered'].includes(job.status)) return false;
        const expiresAt = new Date(job.expiresAt).getTime();
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      }).length;
      if (active >= (runner.maxConcurrentJobs || 1)) throw new Error('El Pulse Runner QA ya alcanzó su límite de jobs activos.');
    }

    const isResendingCurrentAttempt = review?.state === 'running';
    const maxAttempts = qaAgent.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
    const nextAttempt = isResendingCurrentAttempt ? review!.attempt || 1 : (review?.attempt || 0) + 1;
    if (!isResendingCurrentAttempt && nextAttempt > maxAttempts) {
      throw new Error(
        `El issue '${issue.identifier}' ya agotó sus ${maxAttempts} intentos de revisión. Usá "Devolver al agente" para reiniciarlos, o "Aprobar igual" para forzar un veredicto.`
      );
    }

    const installSnap = await db.collection('github_installations').where('workspaceId', '==', issue.workspaceId).limit(1).get();
    if (installSnap.empty) {
      throw new Error(`El workspace '${issue.workspaceId}' no tiene una instalación de GitHub conectada.`);
    }
    const installation = installSnap.docs[0].data();
    const authorized: string[] = installation.repositoryFullNames || [];
    if (authorized.length > 0 && !authorized.includes(repoFullName)) {
      throw new Error(`'${repoFullName}' no está autorizado en la instalación de GitHub de este workspace.`);
    }

    const budget = await db.runTransaction((tx: Transaction) => checkWorkspaceDispatchBudget(tx, db, issue.workspaceId));
    if (!budget.allowed) {
      const reasonMessage =
        budget.reason === 'paused'
          ? 'los agentes de este workspace están pausados (agentsPaused).'
          : budget.reason === 'daily-cost-cap'
            ? `se alcanzó el techo de gasto diario del workspace (USD ${budget.capUsd}).`
            : `se alcanzó el límite diario de dispatches del workspace (${budget.limit}/día).`;
      throw new Error(`No se puede re-ejecutar la revisión: ${reasonMessage}`);
    }

    const now = new Date().toISOString();
    await issueRef.update({
      'review.dispatchError': FieldValue.delete(),
      'review.dispatchedAt': now,
      'review.dispatchedTo': qaAgentId,
      updatedAt: now,
    });

    if (runnerId && runner) {
      const job = await enqueueRunnerJob(db, {
        workspaceId: issue.workspaceId,
        issueId: data.issueId,
        agentId: qaAgentId,
        runnerId,
        repoFullName,
        contextRepos: [...new Set(prs.map((pr) => pr.repoFullName))],
        mode: 'review',
      }, runnerJobSigningPrivateKey.value());
      await db.collection('agent_runs').doc(job.id).set({
        id: job.id,
        issueId: data.issueId,
        workspaceId: issue.workspaceId,
        agentId: qaAgentId,
        runnerId,
        role: 'qa',
        mode: 'review',
        repo: repoFullName,
        reviewAttempt: nextAttempt,
        startedAt: now,
        date: todayKey(),
      });
      console.log(`[ReviewsRerun] queued signed Runner review job '${job.id}' for '${issue.identifier}' to QA '${qaAgentId}'.`);
    } else {
      const prNumber = prs.find((pr) => pr.repoFullName === repoFullName)?.prNumber;
      const runId = `run-${nanoid(8)}`;
      await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_review', {
        issueId: data.issueId,
        issueIdentifier: issue.identifier,
        workspaceId: issue.workspaceId,
        agentId: qaAgentId,
        agentKind: qaAgent.kind || 'claude',
        reviewAttempt: nextAttempt,
        prNumber,
        runId,
      });
      await db.collection('agent_runs').doc(runId).set({
        id: runId,
        issueId: data.issueId,
        workspaceId: issue.workspaceId,
        agentId: qaAgentId,
        role: 'qa',
        mode: 'review',
        repo: repoFullName,
        reviewAttempt: nextAttempt,
        startedAt: now,
        date: todayKey(),
      });
      console.log(`[ReviewsRerun] re-despachada 'pulse_review' (intento ${nextAttempt}) a '${repoFullName}' vía GitHub Actions QA '${qaAgentId}'.`);
    }

    return { issueId: data.issueId, repoFullName, qaAgentId, attempt: nextAttempt };
  }
}
