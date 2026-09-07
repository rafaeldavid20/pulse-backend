import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { githubAppSlug } from '../../common/secrets';
import { buildInstallState } from '../../github/install-flow';

/**
 * Returns the "Install App" URL the Settings UI redirects the browser to.
 * The `state` param is a short-lived signed JWT (see install-flow.ts) — the
 * client can't build this itself, it has no access to MCP_KEY_PEPPER.
 */
export class CreateInstallUrlAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.createInstallUrl', request, callerUid, callerEmail);
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
    if (!this.caller.uid) {
      throw new Error('Se requiere un usuario autenticado.');
    }

    const state = buildInstallState(data.workspaceId, this.caller.uid);
    const installUrl = `https://github.com/apps/${githubAppSlug.value()}/installations/new?state=${encodeURIComponent(state)}`;
    return { installUrl };
  }
}
