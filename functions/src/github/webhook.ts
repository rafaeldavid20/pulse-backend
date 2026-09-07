import { createHmac, timingSafeEqual } from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { githubWebhookSecret } from '../common/secrets';
import { dispatchPlatformAction } from '../router/platform-actions-router';

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  );
  const got = Buffer.from(signatureHeader);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/**
 * `webhook_events/{deliveryId}` doc via `create()` (not `set()`): GitHub
 * retries deliveries reusing the same `X-GitHub-Delivery` id, and `create()`
 * throws ALREADY_EXISTS on a duplicate instead of silently overwriting —
 * that's the idempotency check. `expiresAt` is a plain field for now; a
 * Firestore TTL policy on it (30 days) needs to be enabled once from the
 * console/gcloud — not something `firebase deploy` can express in code.
 */
async function claimDelivery(deliveryId: string, eventType: string): Promise<boolean> {
  const db = getFirestore();
  const ref = db.collection('webhook_events').doc(deliveryId);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await ref.create({ deliveryId, eventType, receivedAt: new Date().toISOString(), expiresAt });
    return true;
  } catch (err: any) {
    if (err?.code === 6 /* ALREADY_EXISTS */) return false;
    throw err;
  }
}

function normalizeFromPullRequest(payload: any) {
  const pr = payload.pull_request;
  return {
    event: 'pull_request' as const,
    repoFullName: payload.repository.full_name,
    branch: pr.head.ref,
    prAction: payload.action,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prTitle: pr.title,
    prBody: pr.body || '',
    merged: !!pr.merged,
    draft: !!pr.draft,
  };
}

function normalizeFromCreate(payload: any) {
  if (payload.ref_type !== 'branch') return null;
  return {
    event: 'create' as const,
    repoFullName: payload.repository.full_name,
    branch: payload.ref,
  };
}

export const githubWebhook = onRequest(
  { region: 'us-east4', secrets: [githubWebhookSecret] },
  async (req, res) => {
    // `req.rawBody` is populated by firebase-functions before JSON parsing.
    // Verifying against `JSON.stringify(req.body)` instead would fail on
    // essentially every request — re-serializing changes key order/escaping,
    // so the signature GitHub computed over the original bytes never matches.
    if (!req.rawBody) {
      res.status(500).send('Missing rawBody — cannot verify signature.');
      return;
    }
    if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'] as string | undefined, githubWebhookSecret.value())) {
      res.status(401).send('Invalid signature.');
      return;
    }

    const deliveryId = req.headers['x-github-delivery'] as string | undefined;
    const eventType = req.headers['x-github-event'] as string | undefined;
    if (!deliveryId || !eventType) {
      res.status(400).send('Missing delivery/event headers.');
      return;
    }

    const isNewDelivery = await claimDelivery(deliveryId, eventType);
    if (!isNewDelivery) {
      res.status(202).send('Already processed.');
      return;
    }

    try {
      let normalized: ReturnType<typeof normalizeFromPullRequest> | ReturnType<typeof normalizeFromCreate> | null =
        null;
      if (eventType === 'pull_request') normalized = normalizeFromPullRequest(req.body);
      else if (eventType === 'create') normalized = normalizeFromCreate(req.body);

      if (normalized) {
        const result = await dispatchPlatformAction({ actionCode: 'github.syncFromWebhook', data: normalized });
        if (!result.success) {
          console.error('[githubWebhook] Sync action failed:', result.error);
        }
      }

      res.status(202).send('Processed.');
    } catch (err) {
      console.error('[githubWebhook] Error handling event:', err);
      // Already 202'd nothing yet — GitHub will retry a 500 with a new (or
      // same) delivery id, and claimDelivery above already recorded this
      // one, so a retry of *this exact* delivery id would be treated as a
      // duplicate. That's an acceptable tradeoff over the alternative
      // (claiming after success, which reopens a race with concurrent
      // retries of a slow handler).
      res.status(500).send('Internal error.');
    }
  }
);
