import { timingSafeEqual } from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { generateApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { mcpKeyPepper } from '../common/secrets';
import { DEV_SCOPES, QA_SCOPES } from '../mcp/scopes';
import { isRunnerAvailable } from '../common/utils/runner-availability';

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
    if (!isRunnerAvailable(runner.data)) {
      res.status(409).json({ error: 'Runner is not available; send a fresh online heartbeat before polling.' });
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
    const db = getFirestore();
    const deliveredAt = new Date().toISOString();
    const agent = await db.collection('agents').doc(job.agentId).get();
    if (!agent.exists) {
      await db.collection('runner_jobs').doc(job.id).update({ status: 'canceled', completedAt: deliveredAt, result: 'El agente ya no existe.' });
      res.json({ job: null });
      return;
    }
    // Esta credencial sólo viaja en la respuesta HTTPS al Runner que probó
    // posesión de la credencial de dispositivo. No queda en runner_jobs.
    const { keyId, secret, fullKey, prefix } = generateApiKey();
    const delivered = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(db.collection('runner_jobs').doc(job.id));
      if (!current.exists || current.data()!.status !== 'pending') return false;
      transaction.update(current.ref, { status: 'delivered', deliveredAt });
      transaction.set(db.collection('api_keys').doc(keyId), {
        id: keyId, workspaceId: job.workspaceId, name: `Runner job ${job.id}`,
        hash: hashApiKeySecret(secret, mcpKeyPepper.value()), prefix,
        scopes: agent.data()!.role === 'qa' ? QA_SCOPES : DEV_SCOPES,
        agentId: job.agentId, createdBy: runner.data.ownerMemberId, jobId: job.id,
        issueId: job.issueId, runnerId: runner.id, repoFullName: job.repoFullName,
        expiresAt: job.expiresAt, createdAt: deliveredAt, lastUsedAt: null, revokedAt: null,
      });
      return true;
    });
    if (!delivered) {
      res.json({ job: null });
      return;
    }
    res.json({ job, mcpCredential: fullKey });
  },
);

/** Completa un job entregado; el resultado queda acotado y no acepta logs/secrets arbitrarios. */
export const pulseRunnerComplete = onRequest(
  { region: 'us-east4', cors: true, secrets: [mcpKeyPepper] },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
    const runner = await authenticateRunner(req.headers.authorization);
    if (!runner) { res.status(401).json({ error: 'Invalid runner credential' }); return; }
    const jobId = req.body?.jobId;
    const outcome = req.body?.outcome;
    if (typeof jobId !== 'string' || !['completed', 'failed', 'canceled'].includes(outcome)) {
      res.status(400).json({ error: 'jobId y outcome válido son obligatorios' }); return;
    }
    const jobRef = getFirestore().collection('runner_jobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists || jobSnap.data()!.runnerId !== runner.id) { res.status(404).json({ error: 'Runner job not found' }); return; }
    const job = jobSnap.data()!;
    if (job.status !== 'delivered' || new Date(job.expiresAt).getTime() <= Date.now()) { res.status(409).json({ error: 'Runner job is not completable' }); return; }
    const now = new Date().toISOString();
    await jobRef.update({ status: outcome, completedAt: now, result: typeof req.body?.result === 'string' ? req.body.result.slice(0, 2000) : null });
    await getFirestore().collection('api_keys').where('jobId', '==', jobId).get().then((keys) => Promise.all(keys.docs.map((key) => key.ref.update({ revokedAt: now }))));
    res.json({ jobId, status: outcome, completedAt: now });
  },
);
