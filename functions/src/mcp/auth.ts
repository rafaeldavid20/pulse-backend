import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parseApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { parseOauthToken } from '../common/utils/oauth-token';
import { mcpKeyPepper } from '../common/secrets';

/**
 * Identity resolved from a request's credentials, regardless of mechanism
 * (a `pulse_sk_...` API key, or a `pulse_oauth_...` token minted by the
 * Fase 7 OAuth 2.1 + DCR flow). Tools read `workspaceId`/`agentId` from this,
 * never from the model's input, so an agent can't ask its way into another
 * workspace's data.
 */
export interface McpPrincipal {
  workspaceId: string;
  agentId: string | null;
  scopes: string[];
  source: 'api_key' | 'oauth';
  /** Set when `source === 'api_key'`. */
  apiKeyId?: string;
  /** Set when `source === 'oauth'`. */
  oauthTokenId?: string;
  /**
   * Uid of the user this credential resolves to. Write tools authorize as
   * `agentId ?? createdBy` — a personal API key or an OAuth token (always
   * `agentId: null`, since OAuth is per-human-user) still needs *some* uid
   * to check workspace membership against for `authorize()`.
   */
  createdBy: string;
}

export class McpAuthError extends Error {
  constructor(message: string, public status: 401 | 403 = 401) {
    super(message);
  }
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

// Fire-and-forget, throttled: a write on every tool call would be one extra
// Firestore write per MCP request for no real benefit.
function shouldTouchLastUsed(lastUsedAt: unknown): boolean {
  const parsed = typeof lastUsedAt === 'string' ? Date.parse(lastUsedAt) : 0;
  return Date.now() - parsed > LAST_USED_THROTTLE_MS;
}

/**
 * Authenticates a Bearer credential — either a `pulse_sk_...` API key
 * (`api_keys/{keyId}`) or a `pulse_oauth_...` token (`oauth_tokens/{tokenId}`)
 * — and returns the resolved principal. Throws McpAuthError (never returns
 * null) so callers can't accidentally treat "unauthenticated" as
 * "authenticated as nobody".
 */
export async function authenticateRequest(authorizationHeader: string | undefined): Promise<McpPrincipal> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new McpAuthError('Missing Bearer token in Authorization header.');
  }

  const rawKey = authorizationHeader.slice('Bearer '.length);

  const apiKey = parseApiKey(rawKey);
  if (apiKey) return authenticateApiKey(apiKey);

  const oauthToken = parseOauthToken(rawKey);
  if (oauthToken) return authenticateOauthToken(oauthToken);

  throw new McpAuthError('Malformed bearer token.');
}

async function authenticateApiKey(parsed: { keyId: string; secret: string }): Promise<McpPrincipal> {
  const db = getFirestore();
  const keyRef = db.collection('api_keys').doc(parsed.keyId);
  const snap = await keyRef.get();
  if (!snap.exists) {
    throw new McpAuthError('Invalid API key.');
  }

  const record = snap.data()!;
  if (record.revokedAt) {
    throw new McpAuthError('This API key has been revoked.', 403);
  }

  const expectedHash = hashApiKeySecret(parsed.secret, mcpKeyPepper.value());
  if (expectedHash !== record.hash) {
    throw new McpAuthError('Invalid API key.');
  }

  if (shouldTouchLastUsed(record.lastUsedAt)) {
    keyRef.update({ lastUsedAt: new Date().toISOString(), useCount: FieldValue.increment(1) }).catch((err) => {
      console.warn('[mcp/auth] Failed to update lastUsedAt (non-fatal):', err);
    });
  }

  return {
    workspaceId: record.workspaceId,
    agentId: record.agentId ?? null,
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
    source: 'api_key',
    apiKeyId: parsed.keyId,
    createdBy: record.createdBy,
  };
}

async function authenticateOauthToken(parsed: { tokenId: string; secret: string }): Promise<McpPrincipal> {
  const db = getFirestore();
  const tokenRef = db.collection('oauth_tokens').doc(parsed.tokenId);
  const snap = await tokenRef.get();
  if (!snap.exists) {
    throw new McpAuthError('Invalid OAuth token.');
  }

  const record = snap.data()!;
  if (record.revokedAt) {
    throw new McpAuthError('This OAuth token has been revoked.', 403);
  }

  const expectedHash = hashApiKeySecret(parsed.secret, mcpKeyPepper.value());
  if (expectedHash !== record.hash) {
    throw new McpAuthError('Invalid OAuth token.');
  }

  if (shouldTouchLastUsed(record.lastUsedAt)) {
    tokenRef.update({ lastUsedAt: new Date().toISOString(), useCount: FieldValue.increment(1) }).catch((err) => {
      console.warn('[mcp/auth] Failed to update lastUsedAt (non-fatal):', err);
    });
  }

  return {
    workspaceId: record.workspaceId,
    agentId: null,
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
    source: 'oauth',
    oauthTokenId: parsed.tokenId,
    createdBy: record.userId,
  };
}
