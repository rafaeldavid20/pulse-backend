import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { missingConnectPermissions } from '../../github/client';
import { reusableConnections } from '../../github/workspace-connections';
import { refreshInstallationRepos } from '../../github/installation-sync';

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

    const canManage = await this.assertWorkspaceMember(data.workspaceId, 'admin');
    if (canManage) {
      const choices = await reusableConnections(data.workspaceId, this.caller.uid!);
      for (const choice of choices) {
        try { await refreshInstallationRepos(choice.installationId); } catch { /* keep last known list */ }
      }
    }
    const availableConnections = canManage ? await reusableConnections(data.workspaceId, this.caller.uid!) : [];
    if (snap.empty) return { connected: false, canManage, availableConnections };

    const doc = snap.docs[0].data();

    // Se relee en vivo: es la red de seguridad para un evento de instalación
    // que no llegó (o llegó antes de que existiera TES-278). Si GitHub falla,
    // vale la lista guardada.
    let repositories: string[] = (doc.repositories || []).map((r: any) => r.fullName);
    try {
      if (!canManage) await refreshInstallationRepos(doc.installationId);
      repositories = ((await snap.docs[0].ref.get()).data()?.repositories || []).map((r: any) => r.fullName);
    } catch (error) {
      console.warn('[GithubStatus] no se pudieron releer los repos de la instalación:', error);
    }

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
      uninstalled: !!doc.uninstalledAt, suspended: !!doc.suspendedAt,
      canManage, availableConnections, installationId: String(doc.installationId),
      selectedRepositories: doc.selectedRepositoryFullNames || doc.repositoryFullNames || [],
      accountLogin: doc.accountLogin,
      repositories,
      connectedAt: doc.connectedAt,
      missingPermissions,
      canConnectRepos: missingPermissions.length === 0,
    };
  }
}
