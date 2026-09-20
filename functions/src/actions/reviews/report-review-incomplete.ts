import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { resolveReviewLead, ensureNeedsHumanLabel, notifyNeedsHuman } from '../../common/utils/review-escalation';
import { CreateCommentAction } from '../comments/create-comment';
import { IssueReview } from '../../common/domain.generated';

/**
 * `reviews.reportIncomplete` (D6): el paso de reporte de `pulse-qa.yml`
 * llama a esto al final de cada run, haya o no terminado en un veredicto. A
 * diferencia del reporte del dev (`pulse_release_issue`), acá **nunca se
 * libera la revisión** — si terminó en un veredicto real (`pulse_submit_review`
 * ya corrió y cerró el intento), este llamado es un no-op idempotente. Si no,
 * es la señal de que el run se cortó a mitad de camino (crash, timeout de
 * `--max-turns`, o el propio job nunca arrancó del lado de GitHub) y escala a
 * `needs_human` de inmediato, sin esperar los ~30-40min del barrido
 * (`scheduled/review-sweeper.ts`) que cubre el resto de los casos (por
 * ejemplo, que el `repository_dispatch` nunca haya llegado a arrancar el job).
 */
export class ReportReviewIncompleteAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.reportIncomplete', request, callerUid, callerEmail);
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
    const actorUid = this.caller.uid!;

    if (!data.issueId) {
      throw new Error('Parámetro requerido faltante: issueId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    const review = issue.review as IssueReview | undefined;
    // Ya cerrado (por `reviews.submit`, o por un llamado previo de esta misma
    // acción) — nada que hacer. Idempotente a propósito: el paso de reporte
    // llama a esto siempre, gane o pierda la carrera contra un veredicto real.
    if (!review || review.state !== 'running') {
      return { issueId: data.issueId, escalated: false, reviewState: review?.state };
    }
    // Solo el agente QA al que qa-dispatch le asignó este intento (reclamado
    // o no todavía) puede reportarlo incompleto — mismo criterio de identidad
    // que `reviews.start`/`reviews.submit`.
    if (review.dispatchedTo !== actorUid && review.claimedBy !== actorUid) {
      throw new Error('Solo el agente QA al que se le despachó esta revisión puede reportarla incompleta.');
    }

    const leadId = await resolveReviewLead(db, issue);
    const currentLabels: string[] = Array.isArray(issue.labelIds) ? issue.labelIds : [];
    const labelId = await ensureNeedsHumanLabel(db, issue.workspaceId, issue.teamId);

    const nextReview: IssueReview = {
      ...review,
      state: 'needs_human',
      previousAssigneeId: issue.assigneeId || undefined,
    };

    const now = new Date().toISOString();
    await issueRef.update(
      cleanUndefined({
        review: nextReview,
        assigneeId: leadId || null,
        labelIds: currentLabels.includes(labelId) ? currentLabels : [...currentLabels, labelId],
        updatedAt: now,
        updatedBy: actorUid,
      })
    );

    const reason = data.reason ? String(data.reason).trim() : 'sin detalle.';
    await new CreateCommentAction(
      {
        actionCode: 'comments.create',
        data: {
          issueId: data.issueId,
          body: `**Revisión de QA incompleta (intento ${review.attempt})** — el run terminó sin emitir un veredicto y se escala a needs_human.\n\n${reason}`,
          source: 'mcp',
        },
      },
      actorUid
    ).run();

    await notifyNeedsHuman(
      db,
      issue,
      data.issueId,
      leadId,
      actorUid,
      `El run de QA (intento ${review.attempt}) terminó sin emitir un veredicto. ${reason}`
    );

    return { issueId: data.issueId, escalated: true, attempt: review.attempt };
  }
}
