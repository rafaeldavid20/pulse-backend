import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { FALLBACK_API_VERSION, getOrgLimits, SalesforceApiError } from '../../salesforce/client';
import { loadEnvironmentForWorkspace, sanitizeEnvironment } from './shared';

/**
 * Confirma que la credencial de un entorno sigue viva, pegándole a
 * `/limits` — la lectura más barata que igual obliga a resolver un access
 * token, o sea que ejercita el refresh completo.
 *
 * Un fallo no se propaga como excepción de la acción: que una org esté caída
 * o que un admin haya revocado el token es un **estado** del entorno, no un
 * error de Pulse, y la UI necesita poder mostrarlo.
 */
export class VerifyEnvironmentAction extends PlatformActionHandler {
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.verify', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    const environmentId = this.action.data?.environmentId;
    if (!environmentId) return false;
    const snap = await getFirestore().collection('environments').doc(environmentId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const environmentId: string = this.action.data.environmentId;
    const env = await loadEnvironmentForWorkspace(environmentId, this.resolvedWorkspaceId!);
    const apiVersion = env.salesforce?.apiVersion || FALLBACK_API_VERSION;
    const db = getFirestore();
    const now = new Date().toISOString();

    try {
      const limits = await getOrgLimits(environmentId, apiVersion);
      await db
        .collection('environments')
        .doc(environmentId)
        .set({ connectionState: 'connected', lastVerifiedAt: now, lastAuthError: null }, { merge: true });

      const apiCalls = limits.DailyApiRequests;
      return {
        ok: true,
        environment: sanitizeEnvironment({ ...env, connectionState: 'connected', lastVerifiedAt: now }),
        dailyApiRequests: apiCalls ? { max: apiCalls.Max, remaining: apiCalls.Remaining } : undefined,
      };
    } catch (error) {
      const isAuth = error instanceof SalesforceApiError && (error.status === 401 || error.errorCode === 'invalid_grant');
      const message = error instanceof Error ? error.message : String(error);

      // `sfFetch` ya deja `expired` cuando el refresh token murió; acá sólo
      // se cubre el resto (org caída, red, restricción de IP), que no es una
      // credencial vencida y no debería mostrarse como tal.
      if (!isAuth) {
        await db
          .collection('environments')
          .doc(environmentId)
          .set({ connectionState: 'error', lastVerifiedAt: now, lastAuthError: message }, { merge: true });
      }

      return {
        ok: false,
        reason: isAuth
          ? 'La conexión con esta org caducó o fue revocada. Volvé a conectarla.'
          : `No se pudo contactar la org: ${message}`,
        environment: sanitizeEnvironment({
          ...env,
          connectionState: isAuth ? 'expired' : 'error',
          lastVerifiedAt: now,
        }),
      };
    }
  }
}
