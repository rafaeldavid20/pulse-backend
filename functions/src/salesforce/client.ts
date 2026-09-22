import { getFirestore } from 'firebase-admin/firestore';
import { decryptToken } from './crypto';

/**
 * Versión de la API REST que se usa si no se pudo resolver la de la org.
 * Lo normal es guardar la que devuelve `latestApiVersion()` al conectar
 * (`SalesforceOrgInfo.apiVersion`): una org sandbox puede ir una release
 * adelante de producción, así que fijar una sola versión global para todas
 * las orgs es pedir un 404 en la que va distinta.
 */
export const FALLBACK_API_VERSION = '62.0';

export type LoginHost = 'login' | 'test' | 'custom';

/** Host de autenticación. `custom` exige el My Domain de la org. */
export function authHost(loginHost: LoginHost, customDomain?: string): string {
  if (loginHost === 'custom') {
    if (!customDomain) throw new Error('Falta el dominio de la org para un login host personalizado.');
    return customDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
  return loginHost === 'test' ? 'test.salesforce.com' : 'login.salesforce.com';
}

/**
 * Error de Salesforce con el código propio de la plataforma, para poder
 * decidir sobre él sin parsear texto. `errorCode` es el de la API
 * (`INVALID_SESSION_ID`, `invalid_grant`, `OAUTH_APP_BLOCKED`, …).
 */
export class SalesforceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

function parseErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first?.errorCode || first?.error;
  } catch {
    return undefined;
  }
}

async function asError(res: Response, what: string): Promise<SalesforceApiError> {
  const body = await res.text();
  return new SalesforceApiError(`${what} -> HTTP ${res.status}: ${body}`, res.status, parseErrorCode(body));
}

// --- OAuth ------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  instance_url: string;
  /** URL de identidad, p. ej. `https://login.salesforce.com/id/00D.../005...`. */
  id: string;
  scope?: string;
}

async function tokenRequest(host: string, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://${host}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw await asError(res, 'Salesforce POST /services/oauth2/token');
  return (await res.json()) as TokenResponse;
}

/**
 * Canjea el `code` del redirect por access + refresh token.
 *
 * Las credenciales de la app vienen por parámetro y no de un secret global:
 * desde Spring '26 Salesforce no deja crear Connected Apps, y una External
 * Client App `Local` sólo vale en la org donde se creó. O sea que cada org
 * trae su propia External Client App, con su propio consumer key.
 */
export async function exchangeAuthorizationCode(
  host: string,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string
): Promise<TokenResponse> {
  return tokenRequest(host, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export interface IdentityInfo {
  user_id: string;
  organization_id: string;
  username: string;
  display_name?: string;
}

/** Resuelve quién autorizó y en qué org, pegándole a la URL `id` del token. */
export async function fetchIdentity(idUrl: string, accessToken: string): Promise<IdentityInfo> {
  const res = await fetch(idUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await asError(res, 'Salesforce GET identity');
  return (await res.json()) as IdentityInfo;
}

/**
 * Última versión de la API que soporta esta org. `/services/data` no requiere
 * autenticación, pero se manda el token igual porque una org con restricción
 * de IP lo rechaza sin sesión.
 */
export async function latestApiVersion(instanceUrl: string, accessToken: string): Promise<string> {
  try {
    const res = await fetch(`${instanceUrl}/services/data`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return FALLBACK_API_VERSION;
    const versions = (await res.json()) as { version: string }[];
    const last = versions[versions.length - 1]?.version;
    return last || FALLBACK_API_VERSION;
  } catch {
    return FALLBACK_API_VERSION;
  }
}

/** Invalida un token en Salesforce. Best-effort: si falla, igual se borra de nuestro lado. */
export async function revokeToken(host: string, token: string): Promise<void> {
  await fetch(`https://${host}/services/oauth2/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  });
}

// --- Access token con caché de dos niveles ----------------------------

interface CachedToken {
  token: string;
  expiresAt: string;
}

/**
 * Nivel 1: memoria de la instancia, se pierde en cada cold start. Nivel 2:
 * el doc del entorno, que sobrevive entre instancias. Mismo patrón que
 * `github/app-auth.ts`.
 *
 * Salesforce **no** devuelve `expires_in` al refrescar: la vida de la sesión
 * la fija la política de la org (2h por defecto, pero puede ser 15 min). Por
 * eso se asume una vida corta y, además, `sfFetch` reintenta una vez ante un
 * 401 — la caducidad real sólo la conoce la org.
 */
const memCache = new Map<string, CachedToken>();
const ASSUMED_TOKEN_TTL_MS = 55 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface EnvAuth {
  /** Consumer key de la External Client App de *esta* org. */
  clientId: string;
  clientSecretEnc: string;
  refreshTokenEnc: string;
  accessTokenCache?: CachedToken;
}

async function loadEnvironment(environmentId: string) {
  const snap = await getFirestore().collection('environments').doc(environmentId).get();
  if (!snap.exists) throw new Error(`No existe el entorno '${environmentId}'.`);
  return { ref: snap.ref, data: snap.data()! };
}

/**
 * Marca el entorno como `expired` cuando el refresh token murió. No se
 * reintenta: un `invalid_grant` en loop es cómo se llega a que la org bloquee
 * el Connected App.
 */
async function markExpired(environmentId: string, reason: string): Promise<void> {
  await getFirestore()
    .collection('environments')
    .doc(environmentId)
    .set({ connectionState: 'expired', lastAuthError: reason }, { merge: true });
  memCache.delete(environmentId);
}

async function refreshAccessToken(environmentId: string): Promise<string> {
  const { ref, data } = await loadEnvironment(environmentId);
  const auth = data.auth as EnvAuth | undefined;
  if (!auth?.refreshTokenEnc || !auth.clientId || !auth.clientSecretEnc) {
    throw new Error(`El entorno '${environmentId}' no tiene credenciales; volvé a conectarlo.`);
  }

  const host = authHost(data.salesforce?.loginHost || 'login', data.salesforce?.instanceUrl);
  let body: TokenResponse;
  try {
    body = await tokenRequest(host, {
      grant_type: 'refresh_token',
      refresh_token: decryptToken(auth.refreshTokenEnc),
      client_id: auth.clientId,
      client_secret: decryptToken(auth.clientSecretEnc),
    });
  } catch (error) {
    const code = error instanceof SalesforceApiError ? error.errorCode : undefined;
    if (code === 'invalid_grant') {
      await markExpired(environmentId, 'El refresh token fue revocado o caducó.');
      throw new SalesforceApiError(
        'La conexión con esta org de Salesforce caducó o fue revocada. Volvé a conectarla desde Settings.',
        401,
        'invalid_grant'
      );
    }
    throw error;
  }

  const fresh: CachedToken = {
    token: body.access_token,
    expiresAt: new Date(Date.now() + ASSUMED_TOKEN_TTL_MS).toISOString(),
  };
  memCache.set(environmentId, fresh);
  await ref.set({ auth: { ...auth, accessTokenCache: fresh }, connectionState: 'connected' }, { merge: true });
  return fresh.token;
}

async function getAccessToken(environmentId: string): Promise<string> {
  const now = Date.now();

  const mem = memCache.get(environmentId);
  if (mem && new Date(mem.expiresAt).getTime() - now > REFRESH_MARGIN_MS) return mem.token;

  const { data } = await loadEnvironment(environmentId);
  const cached = (data.auth as EnvAuth | undefined)?.accessTokenCache;
  if (cached && new Date(cached.expiresAt).getTime() - now > REFRESH_MARGIN_MS) {
    memCache.set(environmentId, cached);
    return cached.token;
  }

  return refreshAccessToken(environmentId);
}

/**
 * Llamada a la API REST de la org de un entorno. `path` va desde la raíz de
 * la instancia, p. ej. `/services/data/v62.0/limits`.
 *
 * Ante un 401 refresca una sola vez y reintenta: como Salesforce no dice
 * cuándo vence el access token, la única señal confiable de caducidad es el
 * rechazo. Un segundo 401 se propaga.
 */
export async function sfFetch<T = unknown>(
  environmentId: string,
  path: string,
  init?: RequestInit
): Promise<T | null> {
  const { data } = await loadEnvironment(environmentId);
  const instanceUrl: string | undefined = data.salesforce?.instanceUrl;
  if (!instanceUrl) throw new Error(`El entorno '${environmentId}' no tiene instanceUrl.`);

  const send = async (token: string) =>
    fetch(`${instanceUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });

  let res = await send(await getAccessToken(environmentId));
  if (res.status === 401) {
    res = await send(await refreshAccessToken(environmentId));
  }
  if (!res.ok) throw await asError(res, `Salesforce ${init?.method || 'GET'} ${path}`);
  return res.status === 204 ? null : ((await res.json()) as T);
}

export interface OrgLimits {
  [limitName: string]: { Max: number; Remaining: number };
}

/** Lectura barata que confirma que la credencial sigue viva. La usa `environments.verify`. */
export async function getOrgLimits(environmentId: string, apiVersion: string): Promise<OrgLimits> {
  return (await sfFetch<OrgLimits>(environmentId, `/services/data/v${apiVersion}/limits`)) as OrgLimits;
}
