import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class CreateCommentAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('comments.create', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  // Loads the issue to authorize against its *real* workspaceId — trusting a
  // client-supplied workspaceId here would let anyone comment on any
  // workspace's issue just by guessing/copying an issueId.
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

    if (!data.issueId || !data.body || !String(data.body).trim()) {
      throw new Error('Parámetros requeridos faltantes: issueId, body.');
    }

    const commentId = `cmt-${nanoid(8)}`;
    const comment = {
      id: commentId,
      workspaceId: this.resolvedWorkspaceId,
      issueId: data.issueId,
      authorId: this.caller.uid || 'system',
      body: String(data.body).trim(),
      source: data.source === 'mcp' || data.source === 'github' ? data.source : 'web',
      githubCommentId: data.githubCommentId,
      createdAt: new Date().toISOString(),
    };

    await db.collection('comments').doc(commentId).set(cleanUndefined(comment));
    return comment;
  }
}
