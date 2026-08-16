import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class DeleteProjectAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('projects.delete', request, callerUid, callerEmail);
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
