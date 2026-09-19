import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { IssueReview } from '../../common/domain.generated';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import { tryConsumeDailyDispatch, DAILY_DISPATCH_LIMIT } from '../../common/utils/dispatch-counter';
import { dispatchRepositoryEvent } from '../../github/client';

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
 * breaker diario (`tryConsumeDailyDispatch`) sí se respeta: protege el costo
 * del workspace sin importar quién dispare.
 *
 * Si el intento actual sigue `running` (el caso típico: un run que no
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
    if (!review) {
      throw new Error(`El issue '${issue.identifier}' todavía no tiene una revisión de QA.`);
    }
    if (review.state === 'needs_human') {
      throw new Error('La revisión está escalada a needs_human: usá "Devolver al agente" o "Aprobar igual" en vez de re-ejecutar.');
    }

    const prs = reviewablePrs(issue);
    if (!prs) {
      throw new Error(`El issue '${issue.identifier}' no tiene todos sus PRs abiertos (o hay trabajo pendiente en otro repo), no se puede re-ejecutar la revisión.`);
    }

    const { repoFullName } = await resolveIssueRepo(db, { ...issue, id: data.issueId }, { agentId: issue.assigneeId });
    if (!repoFullName) {
      throw new Error(`No se pudo resolver el repo del issue '${issue.identifier}'.`);
    }

    const qaSnap = await db
      .collection('agents')
      .where('workspaceId', '==', issue.workspaceId)
      .where('role', '==', 'qa')
      .where('enabled', '==', true)
      .where('autonomousMode', '==', true)
      .get();
    const qaDoc = qaSnap.docs.find((d) => d.id !== issue.assigneeId && d.data().reviewRepo === repoFullName);
    if (!qaDoc) {
      throw new Error(`No hay un agente QA habilitado con reviewRepo '${repoFullName}' para re-ejecutar la revisión.`);
    }
    const qaAgent = qaDoc.data();
    const qaAgentId = qaDoc.id;

    const isResendingCurrentAttempt = review.state === 'running';
    const maxAttempts = qaAgent.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
    const nextAttempt = isResendingCurrentAttempt ? review.attempt || 1 : (review.attempt || 0) + 1;
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

    const allowed = await db.runTransaction((tx: Transaction) => tryConsumeDailyDispatch(tx, db, issue.workspaceId));
    if (!allowed) {
      throw new Error(`Se alcanzó el límite diario de dispatches del workspace (${DAILY_DISPATCH_LIMIT}/día).`);
    }

    const now = new Date().toISOString();
    await issueRef.update({
      'review.dispatchedAt': now,
      'review.dispatchedTo': qaAgentId,
      updatedAt: now,
    });

    const prNumber = prs.find((pr) => pr.repoFullName === repoFullName)?.prNumber;
    await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_review', {
      issueId: data.issueId,
      issueIdentifier: issue.identifier,
      workspaceId: issue.workspaceId,
      agentId: qaAgentId,
      agentKind: qaAgent.kind || 'claude',
      reviewAttempt: nextAttempt,
      prNumber,
    });

    const runId = `run-${nanoid(8)}`;
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
    });

    console.log(`[ReviewsRerun] re-despachada 'pulse_review' (intento ${nextAttempt}) para '${issue.identifier}' (${data.issueId}) a '${repoFullName}' vía QA '${qaAgentId}'.`);

    return { issueId: data.issueId, repoFullName, qaAgentId, attempt: nextAttempt };
  }
}
