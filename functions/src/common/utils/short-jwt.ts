import { createHmac, timingSafeEqual } from 'crypto';

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlToBuffer(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Minimal HS256 JWT sign/verify — no dependency needed for a token that's
 * only ever produced and consumed by this backend (e.g. the GitHub App
 * install `state` param, short-lived and HMAC-signed with a secret we
 * already hold, `MCP_KEY_PEPPER`). Not a general-purpose JWT library: no
 * alg negotiation, no `kid`, nothing an attacker could downgrade.
 */
export function signShortJwt<T extends object>(payload: T, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
  const signature = createHmac('sha256', secret).update(unsigned).digest();
  return `${unsigned}.${base64url(signature)}`;
}

export function verifyShortJwt<T extends object>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const expectedSig = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const gotSig = base64urlToBuffer(sigB64);
  if (expectedSig.length !== gotSig.length || !timingSafeEqual(expectedSig, gotSig)) return null;

  try {
    const payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}
