import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

const VALID_PR_STATES = ['open', 'draft', 'merged', 'closed'];

/**
 * Records a PR's number/URL/state on the issue. Manual for now (the caller —
 * a human or an agent that just opened the PR — supplies the numbers); Fase
 * 4's webhook is what keeps this in sync automatically afterwards.
 */
export class LinkPrAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.linkPr', request, callerUid, callerEmail);
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

    if (!data.issueId || !data.prNumber || !data.prUrl) {
      throw new Error('Parámetros requeridos faltantes: issueId, prNumber, prUrl.');
    }
    const prState = VALID_PR_STATES.includes(data.prState) ? data.prState : 'open';

    const issueRef = db.collection('issues').doc(data.issueId);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    }

    const now = new Date().toISOString();
    await issueRef.update({
      'git.prNumber': data.prNumber,
      'git.prUrl': data.prUrl,
      'git.prState': prState,
      'git.lastSyncedAt': now,
      updatedAt: now,
    });

    return { issueId: data.issueId, prNumber: data.prNumber, prUrl: data.prUrl, prState };
  }
}
