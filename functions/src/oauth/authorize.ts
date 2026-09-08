import { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { firebaseWebApiKey } from '../common/secrets';
import { renderAuthorizePage, renderAuthorizeError } from './authorize-page';
import { OAUTH_CODE_TTL_MS } from './constants';

interface OauthClientRecord {
  id: string;
  redirectUris: string[];
  name: string;
}

async function loadClient(clientId: string): Promise<OauthClientRecord | null> {
  if (!clientId) return null;
  const snap = await getFirestore().collection('oauth_clients').doc(clientId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    id: clientId,
    redirectUris: Array.isArray(data.redirectUris) ? data.redirectUris : [],
    name: typeof data.name === 'string' ? data.name : 'MCP Client',
  };
}

/**
 * GET/POST /authorize (Hosting-rewritten, see firebase.json).
 *
 * GET renders the login+consent page. POST is the two-step XHR the page's
 * own inline script makes after Firebase Auth sign-in: `step: 'workspaces'`
 * lists the user's workspaces, `step: 'consent'` mints the single-use code
 * and hands back the redirect target as JSON — never a 3xx here, since it's
 * a fetch() from the page's own script rather than a browser navigation;
 * the script does `window.location.href = data.redirectTo` itself.
 */
export const oauthAuthorize = onRequest({ region: 'us-east4', secrets: [firebaseWebApiKey] }, async (req, res) => {
  if (req.method === 'GET') {
    await handleGet(req, res);
    return;
  }
  if (req.method === 'POST') {
    await handlePost(req, res);
    return;
  }
  res.status(405).send('Method Not Allowed');
});

async function handleGet(req: ExpressRequest, res: ExpressResponse) {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

  if (response_type !== 'code') {
    res.status(400).send(renderAuthorizeError('response_type debe ser "code".'));
    return;
  }
  if (typeof code_challenge !== 'string' || !code_challenge || code_challenge_method !== 'S256') {
    res.status(400).send(renderAuthorizeError('Se requiere PKCE (code_challenge y code_challenge_method=S256).'));
    return;
  }

  const client = await loadClient(typeof client_id === 'string' ? client_id : '');
  if (!client) {
    res.status(400).send(renderAuthorizeError('client_id desconocido. El cliente debe registrarse primero via POST /register.'));
    return;
  }
  if (typeof redirect_uri !== 'string' || !client.redirectUris.includes(redirect_uri)) {
    res.status(400).send(renderAuthorizeError('redirect_uri no coincide con lo registrado para este client_id.'));
    return;
  }

  res.status(200).send(
    renderAuthorizePage({
      firebaseApiKey: firebaseWebApiKey.value(),
      clientName: client.name,
      params: {
        client_id: client.id,
        redirect_uri,
        code_challenge,
        state: typeof state === 'string' ? state : '',
        scope: typeof scope === 'string' ? scope : '',
      },
    })
  );
}

async function handlePost(req: ExpressRequest, res: ExpressResponse) {
  const body = req.body || {};
  const { step, idToken, client_id, redirect_uri, code_challenge } = body;

  if (typeof idToken !== 'string' || !idToken) {
    res.status(400).json({ error: 'invalid_request', error_description: 'Falta idToken.' });
    return;
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: 'invalid_request', error_description: 'Sesión inválida, volvé a iniciar sesión.' });
    return;
  }

  // Re-validated on every step, not trusted from the GET step: this is the
  // security-critical check (an attacker-controlled redirect_uri would leak
  // the auth code), and the only source of truth for it is oauth_clients —
  // never the client-echoed request body.
  const client = await loadClient(typeof client_id === 'string' ? client_id : '');
  if (!client || typeof redirect_uri !== 'string' || !client.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_request', error_description: 'client_id/redirect_uri inválidos.' });
    return;
  }

  const db = getFirestore();

  if (step === 'workspaces') {
    const memberSnaps = await db.collection('members').where('userId', '==', decoded.uid).get();
    const workspaceIds = [...new Set(memberSnaps.docs.map((d) => d.data().workspaceId as string))];
    const workspaces = await Promise.all(
      workspaceIds.map(async (id) => {
        const wsSnap = await db.collection('workspaces').doc(id).get();
        return { id, name: wsSnap.exists ? wsSnap.data()!.name || id : id };
      })
    );
    res.status(200).json({ workspaces });
    return;
  }

  if (step === 'consent') {
    const { workspaceId, state } = body;
    if (typeof workspaceId !== 'string' || !workspaceId) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Falta workspaceId.' });
      return;
    }
    if (typeof code_challenge !== 'string' || !code_challenge) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Falta code_challenge.' });
      return;
    }

    const memberSnap = await db.collection('members').doc(`${workspaceId}_${decoded.uid}`).get();
    if (!memberSnap.exists) {
      res.status(403).json({ error: 'access_denied', error_description: 'No sos miembro de ese workspace.' });
      return;
    }

    const code = nanoid(32);
    await db
      .collection('oauth_codes')
      .doc(code)
      .set({
        clientId: client.id,
        userId: decoded.uid,
        workspaceId,
        codeChallenge: code_challenge,
        redirectUri: redirect_uri,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS).toISOString(),
        used: false,
      });

    const redirectTo = new URL(redirect_uri);
    redirectTo.searchParams.set('code', code);
    if (typeof state === 'string' && state) redirectTo.searchParams.set('state', state);

    res.status(200).json({ redirectTo: redirectTo.toString() });
    return;
  }

  res.status(400).json({ error: 'invalid_request', error_description: 'step inválido.' });
}
