import { initializeApp } from 'firebase-admin/app';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { PlatformActionRequest } from './common/platform-actions/interfaces';
import { dispatchPlatformAction } from './router/platform-actions-router';
import { mcpKeyPepper, githubAppId, githubAppPrivateKeyB64, githubAppSlug } from './common/secrets';
export { pulseMcp } from './mcp';
export { githubSetup, githubCallback } from './github/install-flow';
export { githubWebhook } from './github/webhook';
export { agentDispatchTrigger } from './triggers/agent-dispatch';
export { syncMemberClaimsTrigger } from './triggers/sync-member-claims';
export { oauthProtectedResourceMetadata, oauthAuthorizationServerMetadata } from './oauth/well-known';
export { oauthRegister } from './oauth/register';
export { oauthAuthorize } from './oauth/authorize';
export { oauthToken } from './oauth/token';

// Initialize Firebase Admin SDK once
initializeApp();

/**
 * Pulse Platform Action Cloud Function (v2 Callable)
 * Receives platform action requests from Pulse web client, executes authorized action,
 * logs audit trail in platform_actions collection, and manages state transitions.
 */
export const pulsePlatformAction = onCall(
  {
    cors: true,
    region: 'us-east4',
    secrets: [mcpKeyPepper, githubAppId, githubAppPrivateKeyB64, githubAppSlug],
  },
  async (request) => {
    const callerUid = request.auth?.uid;
    const callerEmail = request.auth?.token?.email as string | undefined;

    const actionRequest = request.data as PlatformActionRequest;

    if (!actionRequest || !actionRequest.actionCode) {
      throw new HttpsError('invalid-argument', 'El parámetro "actionCode" es obligatorio.');
    }

    console.log(
      `[PulsePlatformAction] Request received: ${actionRequest.actionCode} from user: ${callerUid || 'anonymous'}`
    );

    const result = await dispatchPlatformAction(actionRequest, callerUid, callerEmail);

    if (!result.success) {
      throw new HttpsError('internal', result.error || 'Falló la ejecución de la acción de plataforma.');
    }

    return result;
  }
);
