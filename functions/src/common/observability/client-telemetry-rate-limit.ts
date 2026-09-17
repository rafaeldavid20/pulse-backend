import { createHash } from 'crypto';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';

/** Distinct error signatures a single user can have forwarded to Argus per hour. */
const HOURLY_SIGNATURE_LIMIT = 20;

function currentHourBucket(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/**
 * Groups by name + message + first stack frame so a single error looping
 * (e.g. a retry storm hitting the same failure thousands of times) collapses
 * into one signature instead of exhausting the user's hourly budget on its
 * own and starving other, genuinely distinct errors.
 */
function errorSignature(error: { name: string; message: string; stack?: string }): string {
  const firstFrame = error.stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const raw = `${error.name}|${error.message}|${firstFrame ?? ''}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

type RateLimitDecision = {
  /** Whether this specific error should be forwarded to Argus. */
  forward: boolean;
  /** Set only on the transaction that first pushes the user over the cap this hour. */
  justLimited: boolean;
};

/**
 * Per-user, per-hour cap on client-reported errors forwarded to Argus,
 * mirroring the `agent_dispatch_counters` pattern (a Firestore counter doc
 * keyed by user + time bucket). Unlike that circuit breaker, this one never
 * blocks the caller: it only decides whether `pulseClientTelemetry` relays
 * the error onward — telemetry must never break the user's recovery path.
 *
 * The incident this guards against (TES-192) arrived as authenticated,
 * legitimately-shaped calls, so this counts real invocations rather than
 * trusting anything client-supplied.
 */
export async function checkClientTelemetryRateLimit(
  userId: string,
  error: { name: string; message: string; stack?: string }
): Promise<RateLimitDecision> {
  const db = getFirestore();
  const hour = currentHourBucket();
  const counterRef = db.collection('client_telemetry_counters').doc(`${userId}_${hour}`);
  const signature = errorSignature(error);

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data()! : undefined;
    const signatures: Record<string, true> = data?.signatures ?? {};

    if (signatures[signature]) {
      // Same error already forwarded once this window: collapse the repeat.
      return { forward: false, justLimited: false };
    }

    const distinctCount = Object.keys(signatures).length;
    if (distinctCount >= HOURLY_SIGNATURE_LIMIT) {
      const alreadyLogged = !!data?.limitLoggedAt;
      if (!alreadyLogged) {
        tx.set(counterRef, { userId, hour, limitLoggedAt: new Date().toISOString() }, { merge: true });
      }
      return { forward: false, justLimited: !alreadyLogged };
    }

    tx.set(
      counterRef,
      {
        userId,
        hour,
        [`signatures.${signature}`]: true,
        signatureCount: FieldValue.increment(1),
      },
      { merge: true }
    );
    return { forward: true, justLimited: false };
  });
}
