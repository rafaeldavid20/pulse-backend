import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import {
  adjustParentCounters,
  collectSubtree,
  detachChildren,
  doneWeight,
} from '../../common/utils/hierarchy';

export class DeleteIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.delete', request, callerUid, callerEmail);
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
      throw new Error('Identificador de issue (id) es obligatorio para eliminar.');
    }

    const issueRef = db.collection('issues').doc(data.id);
    const snap = await issueRef.get();
    if (!snap.exists) {
      return { id: data.id, deleted: true, alreadyGone: true };
    }
    const issue = snap.data()!;

    // Qué pasa con los hijos. Por defecto se desprenden (quedan vivos, sin
    // padre): borrar un subárbol entero porque alguien borró la épica es
    // destructivo e irreversible, así que hay que pedirlo explícitamente con
    // `cascade: true`.
    let detached = 0;
    let cascadeDeleted = 0;

    if (data.cascade === true) {
      const subtree = await collectSubtree(db, data.id);
      const batch = db.batch();
      for (const id of subtree) batch.delete(db.collection('issues').doc(id));
      await batch.commit();
      cascadeDeleted = subtree.length - 1;
    } else {
      detached = await detachChildren(db, data.id);
      await issueRef.delete();
    }

    await adjustParentCounters(db, issue.parentId, -1, -doneWeight(issue.status));

    return { id: data.id, deleted: true, detachedChildren: detached, cascadeDeleted };
  }
}
