import { timingSafeEqual } from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { hashApiKeySecret } from '../common/utils/api-key';
import { mcpKeyPepper } from '../common/secrets';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function parseCredential(authorization?: string): { runnerId: string; secret: string } | null {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const separator = token.indexOf('.');
  if (separator < 1) return null;
  const runnerId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^runner-[A-Za-z0-9_-]{12}$/.test(runnerId) || secret.length < 32) return null;
  return { runnerId, secret };
}

async function authenticateRunner(authorization?: string) {
  const credential = parseCredential(authorization);
  if (!credential) return null;
  const snap = await getFirestore().collection('runners').doc(credential.runnerId).get();
  if (!snap.exists) return null;
  if (snap.data()!.revokedAt) return null;
  const expected = String(snap.data()!.deviceSecretHash || '');
  if (!expected) return null;
  const actual = hashApiKeySecret(credential.secret, mcpKeyPepper.value());
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) return null;
  return { id: credential.runnerId, data: snap.data()! };
}

/**
 * Outbound-only endpoint used by the local Runner. It proves possession of
 * the device credential issued during pairing, then records liveness without
 * ever receiving a Claude/Codex credential.
 */
export const pulseRunnerHeartbeat = onRequest(
  { region: 'us-east4', cors: true, secrets: [mcpKeyPepper] },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }
    const runner = await authenticateRunner(req.headers.authorization);
    if (!runner) {
      res.status(401).json({ error: 'Invalid runner credential' });
      return;
    }
    const status = req.body?.status;
    if (!['online', 'busy', 'paused'].includes(status)) {
      res.status(400).json({ error: 'Invalid runner status' });
      return;
    }
    const now = new Date().toISOString();
    await getFirestore().collection('runners').doc(runner.id).update({ status, lastHeartbeatAt: now, updatedAt: now });
    res.json({ runnerId: runner.id, status, lastHeartbeatAt: now });
  },
);

/** The Runner polls this endpoint over its established outbound connection. */
export const pulseRunnerPoll = onRequest(
  { region: 'us-east4', cors: true, secrets: [mcpKeyPepper] },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }
    const runner = await authenticateRunner(req.headers.authorization);
    if (!runner) {
      res.status(401).json({ error: 'Invalid runner credential' });
      return;
    }
    const jobs = await getFirestore().collection('runner_jobs').where('runnerId', '==', runner.id).limit(20).get();
    const now = Date.now();
    const pending = jobs.docs
      .map((doc) => doc.data())
      .filter((job) => job.status === 'pending' && new Date(job.expiresAt).getTime() > now)
      .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    if (pending.length === 0) {
      res.json({ job: null });
      return;
    }
    const job = pending[0];
    await getFirestore().collection('runner_jobs').doc(job.id).update({ status: 'delivered', deliveredAt: new Date().toISOString() });
    res.json({ job });
  },
);
