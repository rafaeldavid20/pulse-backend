import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { parseApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { mcpKeyPepper } from '../common/secrets';

/**
 * Identity resolved from a request's credentials, regardless of mechanism
 * (API key today, OAuth later — see the MCP auth phase in the plan). Tools
 * read `workspaceId`/`agentId` from this, never from the model's input, so
 * an agent can't ask its way into another workspace's data.
 */
export interface McpPrincipal {
  workspaceId: string;
  agentId: string | null;
  scopes: string[];
  source: 'api_key';
  apiKeyId: string;
}

export class McpAuthError extends Error {
  constructor(message: string, public status: 401 | 403 = 401) {
    super(message);
  }
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Authenticates a Bearer API key against `api_keys/{keyId}` and returns the
 * resolved principal. Throws McpAuthError (never returns null) so callers
 * can't accidentally treat "unauthenticated" as "authenticated as nobody".
 */
export async function authenticateRequest(authorizationHeader: string | undefined): Promise<McpPrincipal> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new McpAuthError('Missing Bearer token in Authorization header.');
  }

  const rawKey = authorizationHeader.slice('Bearer '.length);
  const parsed = parseApiKey(rawKey);
  if (!parsed) {
    throw new McpAuthError('Malformed API key.');
  }

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

  // Fire-and-forget, throttled: a write on every tool call would be one
  // extra Firestore write per MCP request for no real benefit.
  const lastUsedAt = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (Date.now() - lastUsedAt > LAST_USED_THROTTLE_MS) {
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
  };
}
