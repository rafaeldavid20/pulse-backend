import { onRequest } from 'firebase-functions/v2/https';
import {
  PULSE_MCP_RESOURCE_URL,
  OAUTH_ISSUER_URL,
  OAUTH_AUTHORIZATION_ENDPOINT,
  OAUTH_TOKEN_ENDPOINT,
  OAUTH_REGISTRATION_ENDPOINT,
} from './constants';

const RESPONSE_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300',
};

/**
 * RFC 9728 Protected Resource Metadata. Reachable at
 * `/.well-known/oauth-protected-resource` via the Hosting rewrite in
 * firebase.json — see constants.ts for why this can't just be a Cloud
 * Function path.
 */
export const oauthProtectedResourceMetadata = onRequest({ region: 'us-east4' }, (req, res) => {
  res.set(RESPONSE_HEADERS).status(200).json({
    resource: PULSE_MCP_RESOURCE_URL,
    authorization_servers: [OAUTH_ISSUER_URL],
  });
});

/**
 * RFC 8414 Authorization Server Metadata. Reachable at
 * `/.well-known/oauth-authorization-server` via the Hosting rewrite.
 */
export const oauthAuthorizationServerMetadata = onRequest({ region: 'us-east4' }, (req, res) => {
  res.set(RESPONSE_HEADERS).status(200).json({
    issuer: OAUTH_ISSUER_URL,
    authorization_endpoint: OAUTH_AUTHORIZATION_ENDPOINT,
    token_endpoint: OAUTH_TOKEN_ENDPOINT,
    registration_endpoint: OAUTH_REGISTRATION_ENDPOINT,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});
