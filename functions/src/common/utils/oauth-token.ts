import { nanoid } from 'nanoid';

/**
 * OAuth access token format: `pulse_oauth_<tokenId(12)>_<secret(32)>`. Mirrors
 * api-key.ts's `pulse_sk_...` shape exactly (tokenId doubles as the Firestore
 * doc id in `oauth_tokens`, hashing reuses `hashApiKeySecret` with the same
 * MCP_KEY_PEPPER) — the only difference from an API key is provenance
 * (minted by POST /token, not the apikeys.create Platform Action) and the
 * `McpPrincipal.source` it resolves to in mcp/auth.ts.
 */
export interface GeneratedOauthToken {
  tokenId: string;
  secret: string;
  fullToken: string;
}

export function generateOauthToken(): GeneratedOauthToken {
  const tokenId = nanoid(12);
  const secret = nanoid(32);
  return { tokenId, secret, fullToken: `pulse_oauth_${tokenId}_${secret}` };
}

export interface ParsedOauthToken {
  tokenId: string;
  secret: string;
}

/** Parses a presented `Authorization: Bearer <token>` value. Returns null if malformed. */
export function parseOauthToken(rawToken: string): ParsedOauthToken | null {
  const match = /^pulse_oauth_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{32})$/.exec(rawToken.trim());
  if (!match) return null;
  return { tokenId: match[1], secret: match[2] };
}
