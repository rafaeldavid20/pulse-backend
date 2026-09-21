import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { sanitizeEnvironment } from './shared';

/**
 * Vista no sensible de los entornos de un workspace. `environments` es
 * Admin-SDK-only porque guarda el refresh token de cada org, así que esta
 * acción es la única forma que tiene el frontend de saber qué hay conectado
 * — el mismo rol que cumple `github.status` para la instalación de GitHub.
 */
export class ListEnvironmentsAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.list', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const snap = await getFirestore()
      .collection('environments')
      .where('workspaceId', '==', this.action.data.workspaceId)
      .get();

    const environments = snap.docs
      .map((d) => sanitizeEnvironment(d.data()))
      .sort((a, b) => a.position - b.position);

    return { environments };
  }
}
