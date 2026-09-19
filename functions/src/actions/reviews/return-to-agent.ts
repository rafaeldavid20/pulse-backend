import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { IssueReview } from '../../common/domain.generated';
import { CreateCommentAction } from '../comments/create-comment';

/**
 * `reviews.returnToAgent` (D7): "Devolver al agente" — solo desde
 * `needs_human`. Reasigna al dev original (`review.previousAssigneeId`,
 * poblado por `reviews.submit`/D5, `reviews.reportIncomplete`/D6 y el barrido
 * de revisiones colgadas cuando escalan) y resetea `review.attempt` para
 * darle una tanda nueva de intentos, igual que si el issue nunca hubiera
 * agotado los anteriores. El intento actual (con sus findings) se archiva en
 * `review.history` antes de resetear, para no perder el registro que muestra
 * D7 en la línea de tiempo.
 *
 * Deliberadamente NO se expone como tool MCP, mismo motivo que
 * `reviews.override`: solo una persona real decide devolver el trabajo, y
 * `authorize()` (default de `PlatformActionHandler`, exige `caller.uid`) ya
 * alcanza para eso — cualquier miembro del workspace puede hacerlo.
 */
export class ReturnToAgentAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.returnToAgent', request, callerUid, callerEmail);
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

    if (!data.issueId || !data.comment || !String(data.comment).trim()) {
      throw new Error('Parámetros requeridos: issueId, comment.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    const review = issue.review as IssueReview | undefined;
    if (!review || review.state !== 'needs_human') {
      throw new Error('Solo se puede devolver al agente una revisión que esté en needs_human.');
    }
    if (!review.previousAssigneeId) {
      throw new Error(`El issue '${issue.identifier}' no tiene un agente dev original registrado al que devolverlo.`);
    }

    const { history: prevHistory, claimedBy: _cb, claimedAt: _ca, previousAssigneeId: _pa, ...archivable } = review;
    const nextReview: IssueReview = {
      state: 'pending',
      attempt: 0,
      history: [...(prevHistory || []), archivable],
    };

    const now = new Date().toISOString();
    await issueRef.update(
      cleanUndefined({
        review: nextReview,
        assigneeId: review.previousAssigneeId,
        status: 'in_progress',
        'git.lastSyncedStatus': 'in_progress',
        updatedAt: now,
        updatedBy: actorUid,
      })
    );

    const body = `**Devuelto al agente**: reasignado para retrabajo tras needs_human, intentos de revisión reiniciados.\n\n${String(data.comment).trim()}`;
    await new CreateCommentAction({ actionCode: 'comments.create', data: { issueId: data.issueId, body, source: 'web' } }, actorUid).run();

    return { issueId: data.issueId, assigneeId: review.previousAssigneeId, status: 'in_progress' };
  }
}
