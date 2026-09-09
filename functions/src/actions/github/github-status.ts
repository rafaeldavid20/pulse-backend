import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { missingConnectPermissions } from '../../github/client';

/**
 * Non-sensitive view of a workspace's GitHub connection — the frontend can't
 * read `github_installations` directly (rules are `if false`, it holds a
 * cached token), so this is the only way Settings knows what's connected.
 */
export class GithubStatusAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.status', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const data = this.action.data;
    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    const snap = await getFirestore()
      .collection('github_installations')
      .where('workspaceId', '==', data.workspaceId)
      .limit(1)
      .get();

    if (snap.empty) return { connected: false };

    const doc = snap.docs[0].data();

    // Que falte un permiso no es un error de estado: la instalación sigue
    // sirviendo para crear ramas y despachar. Solo condiciona si se puede
    // conectar un repo desde la app, así que se informa y no se lanza.
    let missingPermissions: string[] = [];
    try {
      missingPermissions = await missingConnectPermissions(doc.installationId);
    } catch (error) {
      console.warn('[GithubStatus] no se pudieron leer los permisos de la instalación:', error);
    }

    return {
      connected: true,
      accountLogin: doc.accountLogin,
      repositories: (doc.repositories || []).map((r: any) => r.fullName),
      connectedAt: doc.connectedAt,
      missingPermissions,
      canConnectRepos: missingPermissions.length === 0,
    };
  }
}
