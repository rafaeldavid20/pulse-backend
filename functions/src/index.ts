import { initializeApp } from 'firebase-admin/app';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { PlatformActionRequest } from './common/platform-actions/interfaces';
import { dispatchPlatformAction } from './router/platform-actions-router';
import {
  mcpKeyPepper,
  githubAppId,
  githubAppPrivateKeyB64,
  githubAppSlug,
  pulseArgusDsn,
  salesforceTokenKey,
} from './common/secrets';
import { capturePulseException } from './common/observability/argus';
import { checkClientTelemetryRateLimit } from './common/observability/client-telemetry-rate-limit';
export { pulseMcp } from './mcp';
export { githubSetup, githubCallback } from './github/install-flow';
export { githubWebhook } from './github/webhook';
export { salesforceCallback } from './salesforce/oauth-flow';
export { agentDispatchTrigger } from './triggers/agent-dispatch';
export { qaDispatchTrigger } from './triggers/qa-dispatch';
export { issueNotificationsTrigger } from './triggers/notify-on-issue-write';
export { autoCreateCyclesScheduled } from './scheduled/auto-create-cycles';
export { dueSoonRemindersScheduled } from './scheduled/notify-due-soon';
export { reviewSweeperScheduled } from './scheduled/review-sweeper';
export { syncMemberClaimsTrigger } from './triggers/sync-member-claims';
export { oauthProtectedResourceMetadata, oauthAuthorizationServerMetadata } from './oauth/well-known';
export { oauthRegister } from './oauth/register';
export { oauthAuthorize } from './oauth/authorize';
export { oauthToken } from './oauth/token';
export { pulseRunnerHeartbeat, pulseRunnerPoll } from './runners/endpoint';

// Initialize Firebase Admin SDK once
initializeApp();

const clientTelemetryInput = z.object({
  error: z.object({
    name: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(12_000),
    stack: z.string().trim().max(12_000).optional(),
  }).strict(),
  route: z.string().trim().min(1).max(240),
}).strict();

/**
 * Authenticated browser errors are relayed server-side so the Argus DSN never
 * reaches the static Next.js bundle. This endpoint deliberately accepts only
 * a bounded error shape and never treats browser input as an action request.
 */
export const pulseClientTelemetry = onCall(
  { cors: true, region: 'us-east4', secrets: [pulseArgusDsn] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Iniciá sesión para enviar telemetría.');
    }
    const input = clientTelemetryInput.parse(request.data);

    // The incident this guards against (TES-192) arrived as authenticated,
    // legitimately-shaped invocations, so the cap has to live server-side
    // keyed by the caller's uid — nothing client-side can be trusted to
    // enforce it. Scoped to this relay, not to `capturePulseException`
    // itself: the other callers of that helper (pulseMcp, pulsePlatformAction)
    // aren't driven by a browser tab that can get stuck in a retry loop, and
    // don't always have a caller uid to key a per-user counter on.
    const rateLimit = await checkClientTelemetryRateLimit(request.auth.uid, input.error);
    if (!rateLimit.forward) {
      if (rateLimit.justLimited) {
        console.log(`[pulseClientTelemetry] rate limit reached for user '${request.auth.uid}', dropping further reports for this hour.`);
      }
      return { accepted: false };
    }

    const error = new Error(input.error.message);
    error.name = input.error.name;
    if (input.error.stack) error.stack = input.error.stack;
    const accepted = await capturePulseException(error, {
      route: input.route,
      tags: { runtime: 'web', source: 'pulse-app' },
    });
    return { accepted };
  },
);

/**
 * Pulse Platform Action Cloud Function (v2 Callable)
 * Receives platform action requests from Pulse web client, executes authorized action,
 * logs audit trail in platform_actions collection, and manages state transitions.
 */
export const pulsePlatformAction = onCall(
  {
    cors: true,
    region: 'us-east4',
    // Regla del repo: una función declara todo secret que su call graph
    // alcance. `salesforceTokenKey` entra por environments.* — create cifra
    // el secret de la app, y verify/disconnect descifran para resolver un
    // access token.
    secrets: [
      mcpKeyPepper,
      githubAppId,
      githubAppPrivateKeyB64,
      githubAppSlug,
      pulseArgusDsn,
      salesforceTokenKey,
    ],
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

    try {
      const result = await dispatchPlatformAction(actionRequest, callerUid, callerEmail);

      if (!result.success) {
        const error = new Error(result.error || 'Falló la ejecución de la acción de plataforma.');
        throw new HttpsError('internal', error.message);
      }

      return result;
    } catch (error) {
      await capturePulseException(error, {
        route: 'pulsePlatformAction',
        tags: { actionCode: actionRequest.actionCode },
      });
      throw error;
    }
  }
);
