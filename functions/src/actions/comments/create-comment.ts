import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { createNotification, extractMentionedUserIds } from '../../common/utils/notifications';

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
    await this.notify(db, comment);
    return comment;
  }

  /**
   * Notificaciones `comment`/`mentioned` (TES-156). Es un efecto secundario
   * del comentario, no la operación principal: un fallo acá (issue borrado
   * entre medio, etc.) no debe hacer fallar `comments.create`.
   *
   * El veredicto de una revisión de QA ya no se infiere acá por el rol del
   * autor: `reviews.submit`/`reviews.reportIncomplete`/el barrido de
   * revisiones colgadas (D16/TES-212) emiten `review_result`/
   * `changes_requested`/`needs_human` directamente, con la audiencia
   * (creador/lead) y las excepciones de mute que le corresponden a cada
   * desenlace — algo que este método, sin ese contexto, no puede reproducir.
   */
  private async notify(db: FirebaseFirestore.Firestore, comment: Record<string, any>): Promise<void> {
    try {
      const issueSnap = await db.collection('issues').doc(comment.issueId).get();
      if (!issueSnap.exists) return;
      const issue = issueSnap.data()!;

      const membersSnap = await db.collection('members').where('workspaceId', '==', comment.workspaceId).get();
      const members = membersSnap.docs.map((d) => d.data());

      if (issue.assigneeId) {
        await createNotification(db, {
          workspaceId: comment.workspaceId,
          userId: issue.assigneeId,
          actorId: comment.authorId,
          issueId: comment.issueId,
          commentId: comment.id,
          type: 'comment',
          title: `Nuevo comentario en ${issue.identifier}`,
          body: comment.body,
        });
      }

      const mentioned = extractMentionedUserIds(comment.body, members).filter((id) => id !== issue.assigneeId);
      for (const userId of mentioned) {
        await createNotification(db, {
          workspaceId: comment.workspaceId,
          userId,
          actorId: comment.authorId,
          issueId: comment.issueId,
          commentId: comment.id,
          type: 'mentioned',
          title: `Te mencionaron en ${issue.identifier}`,
          body: comment.body,
        });
      }
    } catch (error) {
      console.error('[CreateComment] failed to generate notifications, dropping:', error);
    }
  }
}
