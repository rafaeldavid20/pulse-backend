import { defineSecret } from 'firebase-functions/params';

/**
 * Pepper mixed into API key secrets before hashing (sha256(secret + pepper)).
 * Shared between the apikeys.* Platform Actions (which hash on create) and
 * the MCP request authenticator (which hashes on every call to compare) —
 * both must bind this same secret via `secrets: [mcpKeyPepper]`.
 */
export const mcpKeyPepper = defineSecret('MCP_KEY_PEPPER');

/**
 * DSN issued by the Argus project dedicated to Pulse's backend. It is bound
 * only to server Functions and is never available to the static web client.
 */
export const pulseArgusDsn = defineSecret('PULSE_ARGUS_DSN');

/**
 * Firebase Web API key, used client-side by the OAuth `/authorize` page
 * (Fase 7) to init the Firebase Auth JS SDK for email/password + Google
 * sign-in — the same login the pulse-app frontend already uses. Not secret
 * by nature (every Firebase web app ships this value in its bundle), kept in
 * Secret Manager anyway to avoid hardcoding it and to allow rotation without
 * a code deploy, matching the githubAppId rationale below.
 */
export const firebaseWebApiKey = defineSecret('PULSE_FIREBASE_WEB_API_KEY');

// GitHub App credentials (Fase 3). All defined as secrets (not just the
// private key) to keep a single mechanism for this whole group, even though
// the App ID and Client ID aren't sensitive by themselves.
export const githubAppId = defineSecret('GITHUB_APP_ID');
// Base64 of the .pem GitHub hands you on "Generate a private key" — base64
// sidesteps the `\n`-in-env-var problem entirely.
export const githubAppPrivateKeyB64 = defineSecret('GITHUB_APP_PRIVATE_KEY_B64');
export const githubAppClientId = defineSecret('GITHUB_APP_CLIENT_ID');
export const githubAppClientSecret = defineSecret('GITHUB_APP_CLIENT_SECRET');
export const githubWebhookSecret = defineSecret('GITHUB_WEBHOOK_SECRET');
export const githubAppSlug = defineSecret('GITHUB_APP_SLUG');

// Salesforce (épica O).
//
// No hay un client id/secret global: Salesforce deshabilitó la creación de
// Connected Apps en Spring '26, y su reemplazo —una External Client App con
// Distribution State `Local`— sólo funciona en la org donde se creó. Así que
// cada org trae su propia ECA y sus credenciales viajan cifradas en el doc
// del entorno. Una app única volvería a ser posible empaquetando una ECA en
// un 2GP, y ahí sí harían falta secrets globales.
/**
 * Clave de cifrado de los refresh tokens de Salesforce: 32 bytes en base64.
 * A diferencia de `mcpKeyPepper`, que se usa para *hashear* (one-way), acá
 * hace falta recuperar el token para refrescar el access token, así que es
 * cifrado simétrico reversible (AES-256-GCM) y la clave tiene que ser suya:
 * reusar el pepper mezclaría un secreto de verificación con uno de descifrado.
 */
export const salesforceTokenKey = defineSecret('SALESFORCE_TOKEN_KEY');
