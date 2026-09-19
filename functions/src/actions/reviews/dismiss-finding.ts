import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { IssueReview } from '../../common/domain.generated';

/**
 * `reviews.dismissFinding` (D7): "Descartar finding" — un humano lo da por
 * no válido a mano desde el panel de QA, sin que medie un push del dev. A
 * diferencia de `reviews.resolveFinding` (D5/D9, del dev asignado, solo
 * `fixed`/`disputed`), esto lo puede hacer cualquier miembro del workspace,
 * igual que `reviews.override`.
 */
export class DismissFindingAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.dismissFinding', request, callerUid, callerEmail);
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

    if (!data.issueId || !data.findingId) {
      throw new Error('Parámetros requeridos: issueId, findingId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    const review = issue.review as IssueReview | undefined;
    const findings = review?.findings || [];
    const idx = findings.findIndex((f) => f.id === data.findingId);
    if (idx === -1) {
      throw new Error(`No se encontró el finding '${data.findingId}' en el intento de revisión actual.`);
    }

    const nextFindings = [...findings];
    nextFindings[idx] = {
      ...nextFindings[idx],
      status: 'dismissed',
      resolutionNote: data.note ? String(data.note).trim() : undefined,
    };

    await issueRef.update({
      review: cleanUndefined({ ...review, findings: nextFindings }),
      updatedAt: new Date().toISOString(),
      updatedBy: actorUid,
    });

    return { issueId: data.issueId, findingId: data.findingId, status: 'dismissed' };
  }
}
