import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class RevokeApiKeyAction extends PlatformActionHandler {
  private keyId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('apikeys.revoke', request, callerUid, callerEmail);
    this.keyId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.keyId) return false;
    const snap = await getFirestore().collection('api_keys').doc(this.keyId).get();
    if (!snap.exists) return false;
    return this.isWorkspaceMember(snap.data()!.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.id) {
      throw new Error('Identificador de clave (id) es obligatorio para revocar.');
    }

    const keyRef = db.collection('api_keys').doc(data.id);
    const snap = await keyRef.get();
    if (!snap.exists) {
      throw new Error(`La clave con ID '${data.id}' no existe.`);
    }

    // Marked revoked, not deleted: preserves the audit trail in platform_actions.
    await keyRef.update({ revokedAt: new Date().toISOString() });

    return { id: data.id, revoked: true };
  }
}
