import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { refreshInstallationRepos } from '../../github/installation-sync';
import { reusableConnections, saveWorkspaceConnection } from '../../github/workspace-connections';

export class SaveGithubConnectionAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, uid?: string, email?: string) {
    super('github.saveConnection', request, uid, email);
  }
  protected async authorize() {
    return typeof this.action.data.workspaceId === 'string' && this.assertWorkspaceMember(this.action.data.workspaceId, 'admin');
  }
  protected async handleAction() {
    const { workspaceId, installationId, repositories } = this.action.data;
    if (typeof installationId !== 'string' || !/^\d+$/.test(installationId) || !Array.isArray(repositories) || repositories.some(r => typeof r !== 'string')) {
      throw new Error('Instalación o repositorios inválidos.');
    }
    // Check source permission before any GitHub request or metadata refresh.
    const choices = await reusableConnections(workspaceId, this.caller.uid!);
    if (!choices.some(c => c.installationId === installationId)) throw new Error('No tenés permiso para reutilizar esta instalación.');
    await refreshInstallationRepos(installationId);
    await saveWorkspaceConnection(workspaceId, this.caller.uid!, installationId, repositories);
    return { connected: true };
  }
}
