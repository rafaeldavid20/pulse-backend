import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

/**
 * API key format: `pulse_sk_<keyId(12)>_<secret(32)>`. `keyId` doubles as the
 * Firestore doc id in the `api_keys` collection, so authenticating a request
 * is a single doc lookup by id rather than a query/scan over hashes.
 */
export interface GeneratedApiKey {
  keyId: string;
  secret: string;
  fullKey: string;
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const keyId = nanoid(12);
  const secret = nanoid(32);
  const fullKey = `pulse_sk_${keyId}_${secret}`;
  // Shown in UI lists instead of the full key — enough to recognize a key
  // without exposing anything an attacker could use.
  const prefix = `pulse_sk_${keyId}`;
  return { keyId, secret, fullKey, prefix };
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

/** Parses a presented `Authorization: Bearer <key>` value. Returns null if malformed. */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  const match = /^pulse_sk_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{32})$/.exec(rawKey.trim());
  if (!match) return null;
  return { keyId: match[1], secret: match[2] };
}

/**
 * sha256(secret + pepper), not bcrypt: this is checked on every MCP request
 * (bcrypt's deliberate slowness would add real latency per call), and the
 * secret already carries 32 chars of nanoid entropy rather than
 * human-chosen password entropy that would need slow hashing to protect.
 */
export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHash('sha256').update(secret + pepper).digest('hex');
}
