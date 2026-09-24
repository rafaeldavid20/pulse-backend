import { getFirestore } from 'firebase-admin/firestore';
import { decryptToken } from './crypto';
import { setRepoSecret } from '../github/client';

/** Nombre del secret del repo que guarda la credencial de un entorno. */
export function envSecretName(envKey: string): string {
  return `PULSE_SF_AUTH_${envKey.toUpperCase()}`;
}

/**
 * El `SFDX_AUTH_URL` del entorno: lo que `sf org login sfdx-url` necesita para
 * loguearse sin navegador. Formato del CLI:
 * `force://<clientId>:<clientSecret>:<refreshToken>@<instance>`.
 *
 * Lleva el refresh token y el secret de la External Client App en claro, así
 * que sólo existe en memoria el tiempo de encriptarlo para GitHub
 * (`setRepoSecret`): nunca se loguea, se guarda ni se devuelve.
 */
export function buildSfdxAuthUrl(env: FirebaseFirestore.DocumentData): string {
  const auth = env.auth;
  const instanceUrl: string | undefined = env.salesforce?.instanceUrl;
  if (!auth?.clientId || !auth.clientSecretEnc || !auth.refreshTokenEnc || !instanceUrl) {
    throw new Error(`El entorno '${env.key}' no tiene credenciales completas; volvé a conectarlo.`);
  }
  const host = instanceUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `force://${auth.clientId}:${decryptToken(auth.clientSecretEnc)}:${decryptToken(auth.refreshTokenEnc)}@${host}`;
}

async function installationIdFor(workspaceId: string): Promise<string> {
  const snap = await getFirestore()
    .collection('github_installations')
    .where('workspaceId', '==', workspaceId)
    .limit(1)
    .get();
  if (snap.empty) throw new Error('Este workspace no tiene GitHub conectado todavía (Configuración → Integraciones).');
  return snap.docs[0].data().installationId;
}

/** Escribe la credencial del entorno en un repo. */
export async function writeEnvSecret(env: FirebaseFirestore.DocumentData, repoFullName: string): Promise<string> {
  const installationId = await installationIdFor(env.workspaceId);
  const name = envSecretName(env.key);
  await setRepoSecret(installationId, repoFullName, name, buildSfdxAuthUrl(env));
  return name;
}

/**
 * Tras una reconexión (refresh token nuevo) reescribe el secret en todos los
 * repos atados al entorno, para que nadie tenga que volver a atarlos a mano.
 * Devuelve los repos en los que falló: el llamador los deja marcados con
 * `repoSecretsStale` para que la UI los muestre.
 */
export async function rewriteConnectedRepoSecrets(environmentId: string): Promise<string[]> {
  const snap = await getFirestore().collection('environments').doc(environmentId).get();
  if (!snap.exists) return [];
  const env = snap.data()!;
  const failed: string[] = [];
  for (const conn of env.connectedRepos || []) {
    try {
      await writeEnvSecret(env, conn.repoFullName);
    } catch (error) {
      console.error(`[salesforce] No se pudo reescribir el secret en '${conn.repoFullName}':`, (error as Error).message);
      failed.push(conn.repoFullName);
    }
  }
  return failed;
}

/**
 * Saca un entorno de un repo al que estaba atado (TES-282: cambiar de repo sin
 * desconectar la org). El repo viejo no puede quedar con la credencial de la
 * org ni con un workflow que siga desplegando esa rama:
 *
 * - Borra `PULSE_SF_AUTH_<KEY>`.
 * - Si otros entornos del workspace siguen atados a ese repo, reescribe el
 *   workflow sólo con sus ramas. Si no queda ninguno, borra el workflow y la
 *   key de deploy (secret y `api_keys`), que ya no sirven para nada.
 *
 * Best-effort: el entorno ya está atado al repo nuevo, así que un fallo acá no
 * deshace el cambio; vuelve como aviso para que una persona lo limpie.
 */
export async function detachEnvFromRepo(params: {
  installationId: string;
  workspaceId: string;
  envKey: string;
  repoFullName: string;
  secretName?: string;
  /** Los demás entornos del workspace (sin el que se va). */
  otherEnvs: FirebaseFirestore.DocumentData[];
}): Promise<string[]> {
  const { installationId, workspaceId, envKey, repoFullName, otherEnvs } = params;
  const secretName = params.secretName || envSecretName(envKey);
  const warnings: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      warnings.push(`${what} en ${repoFullName}: ${(error as Error).message}`);
    }
  };
  const { deleteRepoSecret, deleteRepoFile, putRepoFile } = await import('../github/client');
  const { renderDeployWorkflow, DEPLOY_WORKFLOW_PATH, DEPLOY_MCP_SECRET_NAME } = await import('./templates/pulse-deploy-workflow');

  await attempt(`No se pudo borrar el secret '${secretName}'`, () => deleteRepoSecret(installationId, repoFullName, secretName));

  const remaining = otherEnvs.filter(
    (e) => e.trackingBranch && (e.connectedRepos || []).some((c: any) => c.repoFullName === repoFullName)
  );
  if (remaining.length > 0) {
    const { DEPLOY_WORKFLOW_VERSION } = await import('./templates/pulse-deploy-workflow');
    await attempt(`No se pudo actualizar ${DEPLOY_WORKFLOW_PATH}`, async () => {
      await putRepoFile(
        installationId,
        repoFullName,
        DEPLOY_WORKFLOW_PATH,
        renderDeployWorkflow(remaining.map((e) => e.trackingBranch)),
        `chore: el entorno ${envKey} de Pulse ya no despliega desde este repo`
      );
      // El archivo quedó en la versión actual para todos los que siguen atados.
      await Promise.all(
        remaining.map((e) =>
          getFirestore()
            .collection('environments')
            .doc(e.id)
            .update({
              connectedRepos: (e.connectedRepos || []).map((c: any) =>
                c.repoFullName === repoFullName ? { ...c, workflowVersion: DEPLOY_WORKFLOW_VERSION } : c
              ),
            })
        )
      );
    });
    return warnings;
  }

  await attempt(`No se pudo borrar ${DEPLOY_WORKFLOW_PATH}`, () =>
    deleteRepoFile(installationId, repoFullName, DEPLOY_WORKFLOW_PATH, `chore: desatar Pulse de este repo (entorno ${envKey})`)
  );
  await attempt(`No se pudo borrar el secret '${DEPLOY_MCP_SECRET_NAME}'`, () =>
    deleteRepoSecret(installationId, repoFullName, DEPLOY_MCP_SECRET_NAME)
  );
  const keys = await getFirestore()
    .collection('api_keys')
    .where('workspaceId', '==', workspaceId)
    .where('connectedRepo', '==', repoFullName)
    .where('purpose', '==', 'deploy')
    .get();
  const now = new Date().toISOString();
  await Promise.all(keys.docs.filter((d) => !d.data().revokedAt).map((d) => d.ref.update({ revokedAt: now })));
  return warnings;
}
