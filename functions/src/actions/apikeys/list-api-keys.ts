import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class ListApiKeysAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('apikeys.list', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    const snap = await db.collection('api_keys').where('workspaceId', '==', data.workspaceId).get();

    // Never returns `hash` — only what's needed to recognize/manage a key.
    const keys = snap.docs.map((d) => {
      const k = d.data();
      return {
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        agentId: k.agentId ?? null,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt ?? null,
        revokedAt: k.revokedAt ?? null,
      };
    });

    return { keys };
  }
}
