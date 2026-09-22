import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { authHost, revokeToken } from '../../salesforce/client';
import { decryptToken } from '../../salesforce/crypto';
import { deleteRepoSecret } from '../../github/client';
import { loadEnvironmentForWorkspace } from './shared';

/**
 * Desconecta un entorno: revoca el token en Salesforce, borra los secrets
 * que Pulse escribió en los repos, y elimina el doc.
 *
 * Mismo criterio que `agents.disconnectRepo`: primero lo que dejaría acceso
 * vivo si fallara el resto (revocar), después lo best-effort, juntando
 * `warnings[]` en vez de abortar. Una desconexión que falla a la mitad y deja
 * el doc es peor que una que avisa qué no pudo limpiar.
 */
export class DisconnectEnvironmentAction extends PlatformActionHandler {
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('environments.disconnect', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    const environmentId = this.action.data?.environmentId;
    if (!environmentId) return false;
    const snap = await getFirestore().collection('environments').doc(environmentId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.assertWorkspaceMember(this.resolvedWorkspaceId!, 'admin');
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const environmentId: string = this.action.data.environmentId;
    const env = await loadEnvironmentForWorkspace(environmentId, this.resolvedWorkspaceId!);
    const db = getFirestore();
    const warnings: string[] = [];

    if (env.auth?.refreshTokenEnc) {
      try {
        const host = authHost(env.salesforce?.loginHost || 'login', env.salesforce?.instanceUrl);
        await revokeToken(host, decryptToken(env.auth.refreshTokenEnc));
      } catch (error) {
        warnings.push(
          `No se pudo revocar el token en Salesforce (${error instanceof Error ? error.message : String(error)}). ` +
            'Revocá el acceso a mano desde Setup > Connected Apps OAuth Usage.'
        );
      }
    }

    const installSnap = await db
      .collection('github_installations')
      .where('workspaceId', '==', this.resolvedWorkspaceId)
      .limit(1)
      .get();
    const installationId = installSnap.empty ? null : installSnap.docs[0].data().installationId;

    for (const conn of env.connectedRepos || []) {
      if (!installationId) {
        warnings.push(`Quedó el secret '${conn.secretName}' en ${conn.repoFullName}: el workspace ya no tiene GitHub conectado.`);
        continue;
      }
      try {
        await deleteRepoSecret(installationId, conn.repoFullName, conn.secretName);
      } catch (error) {
        warnings.push(
          `No se pudo borrar el secret '${conn.secretName}' de ${conn.repoFullName}: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await db.collection('environments').doc(environmentId).delete();

    return { environmentId, key: env.key, warnings };
  }
}
