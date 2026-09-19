import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { IssueReview } from '../../common/domain.generated';
import { CreateCommentAction } from '../comments/create-comment';

const DECISIONS = ['approved', 'changes_requested'] as const;
type OverrideDecision = (typeof DECISIONS)[number];

/**
 * `reviews.override` (D5): un humano pisa el veredicto del QA — "Aprobar
 * igual" en D7. Deliberadamente NO se expone como tool MCP: se llama desde el
 * callable `pulsePlatformAction` autenticado con Firebase Auth, así que
 * `authorize()` (heredado del default de `PlatformActionHandler`, que exige
 * `caller.uid`) ya garantiza que solo una persona real puede ejecutarlo. Queda
 * registrado con su uid en `review.overriddenBy` para el historial.
 */
export class ReviewsOverrideAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.override', request, callerUid, callerEmail);
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

    const decision = data.decision as OverrideDecision;
    if (!data.issueId || !DECISIONS.includes(decision)) {
      throw new Error(`Parámetros requeridos: issueId, decision (uno de: ${DECISIONS.join(', ')}).`);
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;
    const review = issue.review as IssueReview | undefined;

    const now = new Date().toISOString();
    const nextReview: IssueReview = {
      ...(review || { attempt: 0 }),
      state: decision,
      completedAt: now,
      overriddenBy: actorUid,
      overriddenAt: now,
      overrideReason: data.reason ? String(data.reason).trim() : undefined,
      claimedBy: undefined,
      claimedAt: undefined,
    };

    const updates: Record<string, any> = {
      review: cleanUndefined(nextReview),
      updatedAt: now,
      updatedBy: actorUid,
    };

    if (decision === 'changes_requested') {
      updates.status = 'in_progress';
      updates['git.lastSyncedStatus'] = 'in_progress';
    }
    // 'approved': el status no cambia — el merge sigue siendo humano en el MVP.

    await issueRef.update(updates);

    const reasonLine = data.reason ? `\n\nMotivo: ${String(data.reason).trim()}` : '';
    const body = `**Override humano de revisión**: ${decision === 'approved' ? 'aprobado' : 'cambios solicitados'} manualmente, pisando el veredicto anterior del QA.${reasonLine}`;
    await new CreateCommentAction({ actionCode: 'comments.create', data: { issueId: data.issueId, body, source: 'web' } }, actorUid).run();

    return { issueId: data.issueId, decision, overriddenBy: actorUid };
  }
}
