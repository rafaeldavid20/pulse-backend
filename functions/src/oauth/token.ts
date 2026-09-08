import { createHash } from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { hashApiKeySecret } from '../common/utils/api-key';
import { generateOauthToken } from '../common/utils/oauth-token';
import { mcpKeyPepper } from '../common/secrets';
import { DEFAULT_OAUTH_SCOPES } from './constants';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function base64urlSha256(input: string): string {
  return createHash('sha256').update(input).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * RFC 6749 §4.1.3 token endpoint — POST /token (Hosting-rewritten, see
 * firebase.json). Only `grant_type=authorization_code` is supported (Fase 7
 * is explicitly out-of-scope for refresh tokens). Public client: no
 * client_secret, PKCE's code_verifier stands in for client authentication —
 * verified against the code_challenge stashed on the code by /authorize.
 */
export const oauthToken = onRequest({ region: 'us-east4', secrets: [mcpKeyPepper] }, async (req, res) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_request' });
    return;
  }

  const body = req.body || {};
  const { grant_type, code, redirect_uri, client_id, code_verifier } = body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }
  if (typeof code !== 'string' || typeof code_verifier !== 'string' || typeof redirect_uri !== 'string' || !code) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const db = getFirestore();
  const codeRef = db.collection('oauth_codes').doc(code);
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Código inválido.' });
    return;
  }
  const record = codeSnap.data()!;

  if (record.used) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Código ya utilizado.' });
    return;
  }
  if (Date.parse(record.expiresAt) < Date.now()) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Código expirado.' });
    return;
  }
  if (record.clientId !== client_id || record.redirectUri !== redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'client_id/redirect_uri no coinciden con el código.' });
    return;
  }
  if (base64urlSha256(code_verifier) !== record.codeChallenge) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier inválido.' });
    return;
  }

  // Single-use: mark consumed before minting the token so a retried or
  // replayed request with the same code can't mint a second token.
  await codeRef.update({ used: true });

  const { tokenId, secret, fullToken } = generateOauthToken();
  const hash = hashApiKeySecret(secret, mcpKeyPepper.value());
  await db
    .collection('oauth_tokens')
    .doc(tokenId)
    .set({
      id: tokenId,
      workspaceId: record.workspaceId,
      userId: record.userId,
      clientId: record.clientId,
      hash,
      scopes: DEFAULT_OAUTH_SCOPES,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
    });

  res.status(200).json({
    access_token: fullToken,
    token_type: 'Bearer',
    scope: DEFAULT_OAUTH_SCOPES.join(' '),
  });
});
