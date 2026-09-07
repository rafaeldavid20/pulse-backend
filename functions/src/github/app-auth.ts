import { createSign } from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Signs a GitHub App JWT (RS256) by hand — no dependency needed for this,
 * and it avoids the ESM-only Octokit packages (see client.ts for the fuller
 * rationale). `iat` is backdated 60s to tolerate clock drift between this
 * function and GitHub's servers; `exp` is capped at 10 minutes, GitHub's max.
 */
export function signAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 60, exp: now + 540, iss: githubAppId.value() };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const privateKey = Buffer.from(githubAppPrivateKeyB64.value(), 'base64').toString('utf8');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: string;
}

// Level 1: in-memory, cleared on cold start. Level 2 (Firestore) survives
// across instances/cold starts — installation tokens live 1h, minting one
// per cold start per instance would still be wasteful otherwise.
const memCache = new Map<string, CachedToken>();
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refresh at 50 min, not 60

/**
 * Returns a valid installation access token for `installationId`, minting a
 * fresh one (via the App JWT) only when the cached one is missing or within
 * 10 minutes of expiry.
 */
export async function getInstallationToken(installationId: string): Promise<string> {
  const now = Date.now();

  const mem = memCache.get(installationId);
  if (mem && new Date(mem.expiresAt).getTime() - now > REFRESH_MARGIN_MS) {
    return mem.token;
  }

  const db = getFirestore();
  const docRef = db.collection('github_installations').doc(installationId);
  const snap = await docRef.get();
  const cached = snap.exists ? (snap.data()!.tokenCache as CachedToken | undefined) : undefined;
  if (cached && new Date(cached.expiresAt).getTime() - now > REFRESH_MARGIN_MS) {
    memCache.set(installationId, cached);
    return cached.token;
  }

  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signAppJwt()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`No se pudo mintear un token de instalación de GitHub (HTTP ${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  const fresh: CachedToken = { token: body.token, expiresAt: body.expires_at };

  memCache.set(installationId, fresh);
  await docRef.set({ tokenCache: fresh }, { merge: true });

  return fresh.token;
}
