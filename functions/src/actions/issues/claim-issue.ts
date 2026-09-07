import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class ClaimIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.claim', request, callerUid, callerEmail);
    this.issueId = request.data?.id;
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

    if (!data.id) {
      throw new Error('Identificador de issue (id) es obligatorio para reclamar.');
    }

    const issueRef = db.collection('issues').doc(data.id);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${data.id}' no existe.`);
    }

    const issue = snap.data()!;
    if (issue.agent?.state === 'claimed' && issue.agent?.claimedBy !== this.caller.uid) {
      throw new Error(`El issue ya está reclamado por '${issue.agent.claimedBy}'.`);
    }

    const now = new Date().toISOString();
    await issueRef.update({
      assigneeId: this.caller.uid,
      status: 'in_progress',
      'agent.state': 'claimed',
      'agent.claimedBy': this.caller.uid,
      'agent.claimedAt': now,
      updatedAt: now,
    });

    return { id: data.id, assigneeId: this.caller.uid, status: 'in_progress' };
  }
}
