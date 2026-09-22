import { getFirestore } from 'firebase-admin/firestore';
import { Environment } from '../../common/domain.generated';

/** Claves de entorno: cortas, en minúsculas, y válidas como sufijo de un secret de GitHub. */
export const ENV_KEY_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

export const VALID_TEST_LEVELS = ['NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests'];

export const VALID_LOGIN_HOSTS = ['login', 'test', 'custom'];

/**
 * Vista del entorno que sí puede ver el frontend: todo menos `auth`, que
 * guarda el refresh token cifrado y el access token en claro.
 *
 * Se construye por lista blanca y no borrando `auth`, para que un campo
 * sensible que se agregue después al doc no se filtre por olvido.
 */
export function sanitizeEnvironment(doc: Record<string, any>): Environment & { repoSecretsStale?: boolean } {
  return {
    id: doc.id,
    workspaceId: doc.workspaceId,
    key: doc.key,
    displayName: doc.displayName,
    provider: doc.provider,
    position: doc.position ?? 0,
    trackingBranch: doc.trackingBranch,
    repoFullName: doc.repoFullName,
    isProduction: !!doc.isProduction,
    requiresApproval: !!doc.requiresApproval,
    defaultTestLevel: doc.defaultTestLevel,
    allowDirectWrites: !!doc.allowDirectWrites,
    connectionState: doc.connectionState,
    lastVerifiedAt: doc.lastVerifiedAt,
    deployedSha: doc.deployedSha,
    deployedAt: doc.deployedAt,
    salesforce: doc.salesforce
      ? {
          orgId: doc.salesforce.orgId,
          instanceUrl: doc.salesforce.instanceUrl,
          loginHost: doc.salesforce.loginHost,
          isSandbox: !!doc.salesforce.isSandbox,
          username: doc.salesforce.username,
          apiVersion: doc.salesforce.apiVersion,
        }
      : undefined,
    connectedRepos: doc.connectedRepos || [],
    createdAt: doc.createdAt,
    connectedBy: doc.connectedBy,
    ...(doc.repoSecretsStale ? { repoSecretsStale: true } : {}),
  };
}

/** Carga un entorno y comprueba que pertenezca al workspace esperado. */
export async function loadEnvironmentForWorkspace(
  environmentId: string,
  workspaceId: string
): Promise<Record<string, any>> {
  const snap = await getFirestore().collection('environments').doc(environmentId).get();
  if (!snap.exists) throw new Error(`No existe el entorno '${environmentId}'.`);
  const data = snap.data()!;
  if (data.workspaceId !== workspaceId) {
    // Mismo mensaje que si no existiera: no confirmarle a un caller de otro
    // workspace que este id es real.
    throw new Error(`No existe el entorno '${environmentId}'.`);
  }
  return data;
}
