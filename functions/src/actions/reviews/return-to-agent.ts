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
 * D7 en la línea de tiempo. Si nunca hubo claim, acepta el dev actualmente
 * asignado o de ejecución, comprobando workspace, rol y disponibilidad. Una
 * devolución humana reinicia sólo la tanda de runs del issue, nunca su costo
 * acumulado ni los límites del workspace.
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
    if (!this.caller.uid) return false;
    const member = await getFirestore().collection('members').doc(`${this.resolvedWorkspaceId}_${this.caller.uid}`).get();
    return member.exists && member.data()!.isAgent !== true;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const actorUid = this.caller.uid!;

    if (!data.issueId || !data.comment || !String(data.comment).trim()) {
      throw new Error('Parámetros requeridos: issueId, comment.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const now = new Date().toISOString();
    const assigneeId = await db.runTransaction(async (transaction) => {
      const issueSnap = await transaction.get(issueRef);
      if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
      const issue = issueSnap.data()!;
      const review = issue.review as IssueReview | undefined;
      if (!review || review.state !== 'needs_human') throw new Error('Solo se puede devolver al agente una revisión que esté en needs_human.');

      // Imported PRs and dispatch failures may have never claimed a review.
      // Use a currently assigned dev only after verifying its workspace/role.
      const candidates = [...new Set([review.previousAssigneeId, issue.execution?.agentId, issue.assigneeId].filter(Boolean))];
      let devId: string | undefined;
      for (const candidate of candidates) {
        const agent = await transaction.get(db.collection('agents').doc(candidate));
        const value = agent.data();
        if (value && value.workspaceId === issue.workspaceId && value.role === 'dev' && value.enabled && !value.archivedAt) { devId = candidate; break; }
      }
      if (!devId) throw new Error('Asigná un agente dev habilitado de este workspace antes de devolver el issue.');

      const { history: prevHistory, claimedBy: _cb, claimedAt: _ca, previousAssigneeId: _pa, ...archivable } = review;
      const nextReview: IssueReview = { state: 'pending', attempt: 0, history: [...(prevHistory || []), archivable] };
      transaction.update(issueRef, cleanUndefined({
        review: nextReview, assigneeId: devId, status: 'in_progress',
        'git.lastSyncedStatus': 'in_progress', updatedAt: now, updatedBy: actorUid,
        // Internal server metadata; deliberately absent from writable MCP fields.
        runBudgetResetAt: now, runBudgetResetBy: actorUid,
      }));
      return devId;
    });

    const body = `**Devuelto al agente**: reasignado para retrabajo tras needs_human, intentos de revisión y tanda de runs del issue reiniciados; historial y costo acumulado conservados.\n\n${String(data.comment).trim()}`;
    await new CreateCommentAction({ actionCode: 'comments.create', data: { issueId: data.issueId, body, source: 'web' } }, actorUid).run();

    return { issueId: data.issueId, assigneeId, status: 'in_progress' };
  }
}
