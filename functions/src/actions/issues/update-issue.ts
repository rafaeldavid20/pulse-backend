import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class UpdateIssueAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.update', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const issueId = data.id as string | undefined;

    if (!issueId) {
      throw new Error('Identificador de issue (id) es obligatorio para actualizar.');
    }

    const issueRef = db.collection('issues').doc(issueId);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${issueId}' no existe.`);
    }

    const rawPayload: Record<string, any> = { ...data };
    delete rawPayload.id;

    const updates = cleanUndefined({
      ...rawPayload,
      updatedAt: new Date().toISOString(),
    });

    await issueRef.update(updates);

    return { id: issueId, ...updates };
  }
}
