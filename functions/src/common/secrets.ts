import { defineSecret } from 'firebase-functions/params';

/**
 * Pepper mixed into API key secrets before hashing (sha256(secret + pepper)).
 * Shared between the apikeys.* Platform Actions (which hash on create) and
 * the MCP request authenticator (which hashes on every call to compare) —
 * both must bind this same secret via `secrets: [mcpKeyPepper]`.
 */
export const mcpKeyPepper = defineSecret('MCP_KEY_PEPPER');

/**
 * Firebase Web API key, used client-side by the OAuth `/authorize` page
 * (Fase 7) to init the Firebase Auth JS SDK for email/password + Google
 * sign-in — the same login the pulse-app frontend already uses. Not secret
 * by nature (every Firebase web app ships this value in its bundle), kept in
 * Secret Manager anyway to avoid hardcoding it and to allow rotation without
 * a code deploy, matching the githubAppId rationale below.
 */
export const firebaseWebApiKey = defineSecret('FIREBASE_WEB_API_KEY');

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
