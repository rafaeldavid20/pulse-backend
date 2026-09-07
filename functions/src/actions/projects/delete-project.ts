import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class DeleteProjectAction extends PlatformActionHandler {
  private projectId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('projects.delete', request, callerUid, callerEmail);
    this.projectId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.projectId) return false;
    const snap = await getFirestore().collection('projects').doc(this.projectId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.id) {
      throw new Error('Identificador de proyecto (id) es obligatorio para eliminar.');
    }

    const projRef = db.collection('projects').doc(data.id);
    await projRef.delete();

    return { id: data.id, deleted: true };
  }
}
