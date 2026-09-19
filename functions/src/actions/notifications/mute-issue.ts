import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class MuteIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('notifications.muteIssue', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  // Misma razón que en comments.create / issues.update: la workspaceId real
  // viene del issue, no de lo que mande el caller.
  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const issueId = this.action.data.issueId as string | undefined;

    if (!issueId) {
      throw new Error('Identificador de issue (issueId) es obligatorio.');
    }

    // Guardado en el doc de membership (`members/{workspaceId}_{userId}`),
    // que ya existe uno por usuario+workspace — ver `isIssueMuted` en
    // `common/utils/notifications.ts`, que es quien lo consulta antes de
    // generar cada notificación nueva.
    const memberId = `${this.resolvedWorkspaceId}_${this.caller.uid}`;
    await db.collection('members').doc(memberId).update({
      mutedIssueIds: FieldValue.arrayUnion(issueId),
    });

    return { issueId, muted: true };
  }
}
