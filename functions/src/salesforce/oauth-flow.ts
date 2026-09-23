import { createHash, randomBytes } from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { mcpKeyPepper, salesforceTokenKey, githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';
import { rewriteConnectedRepoSecrets } from './repo-connection';
import { PULSE_APP_URL } from '../common/app-url';
import { signShortJwt, verifyShortJwt } from '../common/utils/short-jwt';
import { cleanUndefined } from '../common/utils/clean';
import { nanoid } from 'nanoid';
import {
  authHost,
  exchangeAuthorizationCode,
  fetchIdentity,
  latestApiVersion,
  LoginHost,
  SalesforceApiError,
} from './client';
import { decryptToken, encryptToken } from './crypto';

const FUNCTIONS_BASE = 'https://us-east4-pulse-app-93.cloudfunctions.net';
export const SALESFORCE_REDIRECT_URI = `${FUNCTIONS_BASE}/salesforceCallback`;

/**
 * Lo mínimo para leer y desplegar metadata, y para poder refrescar sin que el
 * usuario vuelva a loguearse.
 *
 * `id` está porque el callback resuelve quién autorizó pegándole a la URL de
 * identidad que devuelve el token, y ese endpoint exige el scope `id`
 * explícitamente — sin él la conexión falla con un 403 justo después del
 * login, que es el peor momento para descubrirlo.
 */
const OAUTH_SCOPES = 'api id refresh_token offline_access web';

const STATE_TTL_SECONDS = 10 * 60;
const SETTINGS_URL = `${PULSE_APP_URL}/settings/salesforce`;

/**
 * Lo que viaja firmado en el `state`. Es sólo un puntero: el `code_verifier`
 * de PKCE y la configuración del entorno quedan del lado del servidor, en
 * `salesforce_oauth_states`. Mandar el verifier en la URL lo dejaría en el
 * historial del navegador y en el Referer, que es justo lo que PKCE evita.
 */
interface ConnectState {
  stateId: string;
  workspaceId: string;
  uid: string;
}

/** Configuración del entorno que se elige antes de ir a Salesforce y se aplica al volver. */
export interface PendingEnvironmentConfig {
  /**
   * Consumer key de la External Client App de esta org, y su secret cifrado.
   *
   * Son por entorno y no globales porque desde Spring '26 Salesforce no deja
   * crear Connected Apps, y una External Client App `Local` sólo funciona en
   * la org donde se creó: usarla contra otra falla con "Cross-org OAuth flows
   * are not supported". Una app global volvería a ser posible empaquetando una
   * ECA en un 2GP, que es otro proyecto.
   */
  clientId: string;
  clientSecretEnc: string;
  key: string;
  displayName: string;
  position: number;
  trackingBranch: string;
  repoFullName: string;
  isProduction: boolean;
  requiresApproval: boolean;
  defaultTestLevel: string;
  allowDirectWrites: boolean;
  loginHost: LoginHost;
  customDomain?: string;
  /** Entorno existente que se está reconectando, si lo hay. */
  environmentId?: string;
}

async function isWorkspaceAdmin(workspaceId: string, uid: string): Promise<boolean> {
  const snap = await getFirestore().collection('members').doc(`${workspaceId}_${uid}`).get();
  if (!snap.exists) return false;
  const role = snap.data()!.role;
  return role === 'owner' || role === 'admin';
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Deja lista una autorización y devuelve la URL a la que mandar el navegador.
 * La llama `environments.create`, que es quien valida permisos y la config.
 */
export async function beginSalesforceConnect(
  workspaceId: string,
  uid: string,
  config: PendingEnvironmentConfig
): Promise<string> {
  const { verifier, challenge } = pkcePair();
  const stateId = `sfst-${nanoid(16)}`;

  // `cleanUndefined` no es decorativo acá: en el caso más común —conectar un
  // sandbox por primera vez— `config.customDomain` y `config.environmentId`
  // existen como propiedades con valor `undefined`, y el Admin SDK rechaza el
  // write entero ("Cannot use 'undefined' as a Firestore value"). Sin esto,
  // `environments.create` falla antes de devolver la URL y el navegador nunca
  // llega a Salesforce.
  await getFirestore()
    .collection('salesforce_oauth_states')
    .doc(stateId)
    .set(
      cleanUndefined({
        stateId,
        workspaceId,
        uid,
        config,
        codeVerifier: verifier,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + STATE_TTL_SECONDS * 1000).toISOString(),
      })
    );

  const state = signShortJwt<ConnectState>({ stateId, workspaceId, uid }, mcpKeyPepper.value(), STATE_TTL_SECONDS);
  const host = authHost(config.loginHost, config.customDomain);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: SALESFORCE_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Fuerza la pantalla de consentimiento aunque el usuario ya tenga sesión
    // abierta en esa org: sin esto, reconectar con otro usuario reusa
    // silenciosamente el que ya estaba logueado, y la org audita al que no es.
    prompt: 'login consent',
  });

  return `https://${host}/services/oauth2/authorize?${params.toString()}`;
}

function redirectWithError(res: any, code: string): void {
  res.redirect(302, `${SETTINGS_URL}?sf=error&reason=${encodeURIComponent(code)}`);
}

/**
 * Callback URL del Connected App. Salesforce vuelve acá con `code` y el
 * `state` firmado; es donde se escribe `environments/{envId}`.
 */
export const salesforceCallback = onRequest(
  // Las de la GitHub App: una reconexión reescribe el secret en los repos atados.
  { region: 'us-east4', secrets: [mcpKeyPepper, salesforceTokenKey, githubAppId, githubAppPrivateKeyB64] },
  async (req, res) => {
    const db = getFirestore();

    // Salesforce avisa de un rechazo con `error`, no con un code.
    const oauthError = req.query.error as string | undefined;
    if (oauthError) {
      console.warn('[salesforceCallback] Salesforce rechazó la autorización:', oauthError, req.query.error_description);
      redirectWithError(res, oauthError);
      return;
    }

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    if (!code || !state) {
      redirectWithError(res, 'missing_code');
      return;
    }

    const claims = verifyShortJwt<ConnectState>(state, mcpKeyPepper.value());
    if (!claims) {
      redirectWithError(res, 'state_expired');
      return;
    }

    // Consumo del state de una sola vez: el mismo `code` no puede canjearse
    // dos veces, y un replay del redirect no debe volver a escribir el doc.
    const stateRef = db.collection('salesforce_oauth_states').doc(claims.stateId);
    const stateSnap = await stateRef.get();
    if (!stateSnap.exists) {
      redirectWithError(res, 'state_expired');
      return;
    }
    const stateDoc = stateSnap.data()!;
    await stateRef.delete();

    if (new Date(stateDoc.expiresAt).getTime() < Date.now()) {
      redirectWithError(res, 'state_expired');
      return;
    }
    if (stateDoc.workspaceId !== claims.workspaceId || stateDoc.uid !== claims.uid) {
      redirectWithError(res, 'state_mismatch');
      return;
    }
    if (!(await isWorkspaceAdmin(claims.workspaceId, claims.uid))) {
      redirectWithError(res, 'not_admin');
      return;
    }

    const config = stateDoc.config as PendingEnvironmentConfig;

    try {
      const host = authHost(config.loginHost, config.customDomain);
      const tokens = await exchangeAuthorizationCode(
        host,
        code,
        SALESFORCE_REDIRECT_URI,
        stateDoc.codeVerifier,
        config.clientId,
        decryptToken(config.clientSecretEnc)
      );

      if (!tokens.refresh_token) {
        // Sin refresh token la conexión sirve para una sesión y después se
        // muere en silencio. Pasa cuando al Connected App le falta el scope
        // `refresh_token`/`offline_access`.
        redirectWithError(res, 'no_refresh_token');
        return;
      }

      const [identity, apiVersion] = await Promise.all([
        fetchIdentity(tokens.id, tokens.access_token),
        latestApiVersion(tokens.instance_url, tokens.access_token),
      ]);

      const environmentId = config.environmentId || `env-${nanoid(8)}`;
      const now = new Date().toISOString();
      const existing = await db.collection('environments').doc(environmentId).get();

      await db
        .collection('environments')
        .doc(environmentId)
        .set(
          cleanUndefined({
            id: environmentId,
            workspaceId: claims.workspaceId,
            key: config.key,
            displayName: config.displayName,
            provider: 'salesforce',
            position: config.position,
            trackingBranch: config.trackingBranch,
            repoFullName: config.repoFullName,
            isProduction: config.isProduction,
            requiresApproval: config.requiresApproval,
            defaultTestLevel: config.defaultTestLevel,
            // Prod no acepta escritura directa, diga lo que diga quien creó
            // el entorno. Forzarlo acá y no sólo en la UI es la diferencia
            // entre una convención y una garantía.
            allowDirectWrites: config.isProduction ? false : config.allowDirectWrites,
            connectionState: 'connected',
            lastVerifiedAt: now,
            salesforce: {
              orgId: identity.organization_id,
              instanceUrl: tokens.instance_url,
              loginHost: config.loginHost,
              isSandbox: config.loginHost === 'test',
              username: identity.username,
              apiVersion,
            },
            auth: {
              clientId: config.clientId,
              clientSecretEnc: config.clientSecretEnc,
              refreshTokenEnc: encryptToken(tokens.refresh_token),
            },
            createdAt: existing.exists ? existing.data()!.createdAt : now,
            connectedBy: claims.uid,
          }),
          { merge: true }
        );

      // Una reconexión invalida el SFDX_AUTH_URL escrito en los repos, porque
      // embebe el refresh token: se reescribe en todos los atados (O3). Si
      // alguno falla, queda marcado para que la UI ofrezca volver a atarlo.
      if (existing.exists && (existing.data()!.connectedRepos || []).length > 0) {
        const failed = await rewriteConnectedRepoSecrets(environmentId);
        await db.collection('environments').doc(environmentId).update({ repoSecretsStale: failed.length > 0 });
      }

      res.redirect(302, `${SETTINGS_URL}?sf=connected&env=${encodeURIComponent(config.key)}`);
    } catch (error) {
      const code = error instanceof SalesforceApiError ? error.errorCode || String(error.status) : 'unknown';
      console.error('[salesforceCallback] No se pudo completar la conexión:', error);
      redirectWithError(res, code);
    }
  }
);
