import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

/** `agents` is Admin-SDK-only (`allow read, write: if false`), so the
 * frontend can't subscribe to it directly — this is its read path, same
 * reason `apikeys.list` exists next to `apikeys.create`. */
export class ListAgentsAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.list', request, callerUid, callerEmail);
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

    const snap = await db.collection('agents').where('workspaceId', '==', data.workspaceId).get();
    const agents = snap.docs.map((d) => d.data());

    return { agents };
  }
}
