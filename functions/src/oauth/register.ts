import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function isAllowedRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    // Loopback exception (OAuth 2.1 §9.7.2): local MCP inspectors / dev
    // clients run a temporary server on localhost during the flow.
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * RFC 7591 Dynamic Client Registration — POST /register (Hosting-rewritten,
 * see firebase.json). Public clients only (PKCE, no client_secret): the
 * whole flow targets MCP clients like claude.ai that can't keep a secret
 * confidential, so there's nothing meaningful to gate registration on —
 * anyone can self-register a client_id, the same open-DCR pattern most MCP
 * servers use.
 */
export const oauthRegister = onRequest({ region: 'us-east4' }, async (req, res) => {
  for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'invalid_request', error_description: 'Only POST is supported.' });
    return;
  }

  const body = req.body || {};
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(isAllowedRedirectUri) : [];
  if (redirectUris.length === 0 || redirectUris.length !== (body.redirect_uris?.length ?? 0)) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: 'redirect_uris must be a non-empty array of https:// (or http://localhost) URIs.',
    });
    return;
  }

  const clientId = nanoid(24);
  const clientName = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim() : 'MCP Client';

  await getFirestore()
    .collection('oauth_clients')
    .doc(clientId)
    .set({
      id: clientId,
      name: clientName,
      redirectUris,
      createdAt: new Date().toISOString(),
    });

  res.status(201).json({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  });
});
