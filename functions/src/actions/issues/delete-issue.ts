import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class DeleteIssueAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.delete', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.id) {
      throw new Error('Identificador de issue (id) es obligatorio para eliminar.');
    }

    const issueRef = db.collection('issues').doc(data.id);
    await issueRef.delete();

    return { id: data.id, deleted: true };
  }
}
