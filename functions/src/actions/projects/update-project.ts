import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class UpdateProjectAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('projects.update', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const projId = data.id as string | undefined;

    if (!projId) {
      throw new Error('Identificador de proyecto (id) es obligatorio para actualizar.');
    }

    const projRef = db.collection('projects').doc(projId);
    const snap = await projRef.get();
    if (!snap.exists) {
      throw new Error(`El proyecto con ID '${projId}' no existe.`);
    }

    const rawPayload: Record<string, any> = { ...data };
    delete rawPayload.id;

    const updates = cleanUndefined({
      ...rawPayload,
      updatedAt: new Date().toISOString(),
    });

    await projRef.update(updates);

    return { id: projId, ...updates };
  }
}
