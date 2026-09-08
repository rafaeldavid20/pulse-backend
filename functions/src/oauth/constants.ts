/**
 * Fixed URLs for the OAuth 2.1 + DCR flow (Fase 7).
 *
 * Cloud Functions can't be named with a literal `/.well-known/...` path
 * (function names are plain identifiers, one per URL path segment), so the
 * well-known metadata documents plus /register, /authorize and /token are
 * served through Firebase Hosting rewrites (see firebase.json's `hosting`
 * block) at this one shared origin — that's what makes them resolvable at
 * spec-exact paths instead of `/oauthAuthorize` etc.
 *
 * pulseMcp itself keeps its existing cloudfunctions.net URL unchanged (no
 * caller who already uses a Bearer API key is affected): `resource` in the
 * protected-resource metadata points there, while `authorization_servers`
 * points at OAUTH_ISSUER_URL. A client that doesn't do blind well-known
 * discovery still finds the metadata via the
 * `WWW-Authenticate: Bearer resource_metadata="..."` header pulseMcp returns
 * on a 401 (see mcp/index.ts).
 */
export const PULSE_MCP_RESOURCE_URL = 'https://us-east4-pulse-app-93.cloudfunctions.net/pulseMcp';

export const OAUTH_ISSUER_URL = 'https://pulse-app-93.web.app';
export const OAUTH_AUTHORIZATION_ENDPOINT = `${OAUTH_ISSUER_URL}/authorize`;
export const OAUTH_TOKEN_ENDPOINT = `${OAUTH_ISSUER_URL}/token`;
export const OAUTH_REGISTRATION_ENDPOINT = `${OAUTH_ISSUER_URL}/register`;
export const OAUTH_PROTECTED_RESOURCE_METADATA_URL = `${OAUTH_ISSUER_URL}/.well-known/oauth-protected-resource`;
export const OAUTH_AUTHORIZATION_SERVER_METADATA_URL = `${OAUTH_ISSUER_URL}/.well-known/oauth-authorization-server`;

export const FIREBASE_PROJECT_ID = 'pulse-app-93';
export const FIREBASE_AUTH_DOMAIN = `${FIREBASE_PROJECT_ID}.firebaseapp.com`;

// Same scopes apikeys.create defaults to — OAuth tokens grant the same
// baseline access as a personal API key, just minted through a different
// front door.
export const DEFAULT_OAUTH_SCOPES = ['issues:read', 'issues:write', 'projects:write', 'comments:write'];

export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
