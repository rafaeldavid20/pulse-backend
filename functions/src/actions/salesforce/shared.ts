import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionCode, PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { resolveEnvironment, ResolvedEnvironment } from '../../salesforce/read';

/**
 * Base de las lecturas de una org (O2/TES-252). Todas reciben
 * `{ workspaceId, environment }` — `environment` es la clave (`dev`) o el id
 * (`env-xxxx`) — y resuelven el entorno **dentro de `workspaceId`**, que es a
 * su vez lo único que se autoriza. Así, pasar el id de un entorno de otro
 * workspace no sirve aunque el caller sea miembro del suyo: el entorno no se
 * encuentra.
 *
 * Desde el MCP, `workspaceId` es el del principal, nunca el del input del
 * modelo (ver `mcp/tools/salesforce.ts`).
 */
export abstract class SalesforceReadAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(actionCode: PlatformActionCode, request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super(actionCode, request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected abstract read(env: ResolvedEnvironment): Promise<Record<string, any>>;

  protected async handleAction(): Promise<Record<string, any>> {
    const env = await resolveEnvironment(this.workspaceId!, this.action.data.environment);
    const result = await this.read(env);
    return { environment: { id: env.id, key: env.key, displayName: env.displayName, isProduction: env.isProduction }, ...result };
  }

  /**
   * En `platform_actions` queda qué se leyó y de qué entorno, no los datos:
   * son registros del cliente, y un describe puede pasar el tope de 1 MB de
   * un doc. Cada acción agrega su propio resumen.
   */
  protected auditResponse(response: Record<string, any>): Record<string, any> {
    return { environment: response.environment, ...this.auditSummary(response) };
  }

  protected abstract auditSummary(response: Record<string, any>): Record<string, any>;
}
