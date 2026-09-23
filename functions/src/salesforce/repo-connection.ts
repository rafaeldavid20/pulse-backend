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
