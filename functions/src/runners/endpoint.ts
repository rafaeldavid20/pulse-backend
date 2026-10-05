import { configureRunnerRepos } from './configure-repos';
import { parseRunnerReadiness, runnerPreflight } from '../common/utils/runner-preflight';
import { timingSafeEqual } from 'crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { generateApiKey, hashApiKeySecret } from '../common/utils/api-key';
import { mcpKeyPepper } from '../common/secrets';
import { DEV_SCOPES, QA_SCOPES } from '../mcp/scopes';
import { isRunnerAvailable } from '../common/utils/runner-availability';
import { parseRunnerUsageReport } from '../common/utils/runner-usage';
import { safeRunnerJobResult, safeRunnerFailure } from '../common/utils/runner-result';
import { recordRunnerCompletion } from './record-completion';
import { ReportReviewIncompleteAction } from '../actions/reviews/report-review-incomplete';

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
    let readiness;
    try {
      readiness = req.body?.readiness === undefined ? undefined : parseRunnerReadiness(req.body.readiness);
      if (readiness && readiness.workspaceId !== runner.data.workspaceId) throw new Error('Runner workspace mismatch.');
    } catch { res.status(400).json({ error: 'Invalid Runner readiness' }); return; }
    const jobId = req.body?.jobId;
    if (jobId !== undefined && typeof jobId !== 'string') { res.status(400).json({ error: 'Invalid jobId' }); return; }
    let cancelRequested = false;
    if (jobId) {
      const snap = await getFirestore().collection('runner_jobs').doc(jobId).get();
      if (!snap.exists || snap.data()!.runnerId !== runner.id || snap.data()!.workspaceId !== runner.data.workspaceId) {
        res.status(404).json({ error: 'Runner job not found' }); return;
      }
      const job = snap.data()!;
      cancelRequested = !!job.cancelRequestedAt || job.status !== 'delivered' || Date.parse(job.expiresAt) <= Date.now();
    }
    await getFirestore().collection('runners').doc(runner.id).update({ status, lastHeartbeatAt: now, updatedAt: now,
      ...(readiness ? { readiness, readinessCheckedAt: now } : {}),
    });
    res.json({ runnerId: runner.id, status, lastHeartbeatAt: now, cancelRequested });
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
    const preflight = runnerPreflight({ ...agent.data(), id: job.agentId }, { ...runner.data, id: runner.id }, job.workspaceId, job.contextRepos || [job.repoFullName], job.mode);
    if (!preflight.ready) {
      await db.collection('runner_jobs').doc(job.id).update({ status: 'canceled', completedAt: deliveredAt, result: preflight.problems.map((problem) => problem.message).join(' '), failure: { phase: 'preflight', category: 'configuration', correlationId: job.id } });
      res.json({ job: null }); return;
    }
    // Esta credencial sólo viaja en la respuesta HTTPS al Runner que probó
    // posesión de la credencial de dispositivo. No queda en runner_jobs.
    const { keyId, secret, fullKey, prefix } = generateApiKey();
    let deliveredAgent = agent.data()!;
    const delivered = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(db.collection('runner_jobs').doc(job.id));
      if (!current.exists || current.data()!.status !== 'pending') return false;
      const [currentAgent, currentRunner] = await Promise.all([
        transaction.get(db.collection('agents').doc(job.agentId)),
        transaction.get(db.collection('runners').doc(runner.id)),
      ]);
      const check = runnerPreflight(currentAgent.exists ? { ...currentAgent.data(), id: job.agentId } : null, currentRunner.exists ? { ...currentRunner.data(), id: runner.id } : null, job.workspaceId, job.contextRepos || [job.repoFullName], job.mode);
      if (!check.ready) {
        transaction.update(current.ref, { status: 'canceled', completedAt: deliveredAt, result: check.problems.map((problem) => problem.message).join(' '), failure: { phase: 'preflight', category: 'configuration', correlationId: job.id } });
        return false;
      }
      deliveredAgent = currentAgent.data()!;
      transaction.update(current.ref, { status: 'delivered', deliveredAt });
      transaction.set(db.collection('api_keys').doc(keyId), {
        id: keyId, workspaceId: job.workspaceId, name: `Runner job ${job.id}`,
        hash: hashApiKeySecret(secret, mcpKeyPepper.value()), prefix,
        scopes: deliveredAgent.role === 'qa' ? QA_SCOPES : DEV_SCOPES,
        agentId: job.agentId, createdBy: runner.data.ownerMemberId, jobId: job.id,
        issueId: job.issueId, runnerId: runner.id, repoFullName: job.repoFullName,
        repoFullNames: job.contextRepos || [job.repoFullName],
        expiresAt: job.expiresAt, createdAt: deliveredAt, lastUsedAt: null, revokedAt: null,
      });
      return true;
    });
    if (!delivered) {
      res.json({ job: null });
      return;
    }
    const agentData = deliveredAgent;
    res.json({ job, agent: { kind: agentData.kind || 'claude', role: agentData.role || 'dev' }, mcpCredential: fullKey });
  },
);

/** Lets a paired local Runner keep its explicit repository allow-list in sync. */
export const pulseRunnerConfigure = onRequest(
  { region: 'us-east4', cors: true, secrets: [mcpKeyPepper] },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
    const runner = await authenticateRunner(req.headers.authorization);
    if (!runner) { res.status(401).json({ error: 'Invalid runner credential' }); return; }
    try {
      const connectedRepos = await configureRunnerRepos(getFirestore(), runner.id, req.body?.connectedRepos);
      res.json({ runnerId: runner.id, connectedRepos });
    } catch (error) {
      const status = [400, 401, 403].includes((error as any).status) ? (error as any).status : 500;
      res.status(status).json({ error: status === 500 ? 'Could not configure Runner repositories.' : 'Invalid repository scope; expansion requires owner/admin approval in Pulse.' });
    }
  },
);

/** Completa un job entregado; sólo guarda metadatos y contadores validados. */
export const pulseRunnerComplete = onRequest(
  { region: 'us-east4', cors: true, secrets: [mcpKeyPepper] },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }
    const runner = await authenticateRunner(req.headers.authorization);
    if (!runner) { res.status(401).json({ error: 'Invalid runner credential' }); return; }
    const jobId = req.body?.jobId;
    let outcome = req.body?.outcome;
    if (typeof jobId !== 'string' || !['completed', 'failed', 'canceled'].includes(outcome)) {
      res.status(400).json({ error: 'jobId y outcome válido son obligatorios' }); return;
    }
    const db = getFirestore();
    const jobRef = db.collection('runner_jobs').doc(jobId);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists || jobSnap.data()!.runnerId !== runner.id) { res.status(404).json({ error: 'Runner job not found' }); return; }
    const job = jobSnap.data()!;
    if (['completed', 'failed', 'canceled'].includes(job.status)) {
      res.json({ jobId, status: job.status, completedAt: job.completedAt, alreadyCompleted: true }); return;
    }
    if (job.status !== 'delivered' || new Date(job.expiresAt).getTime() <= Date.now()) { res.status(409).json({ error: 'Runner job is not completable' }); return; }
    const agentSnap = await db.collection('agents').doc(job.agentId).get();
    const provider = agentSnap.data()?.kind ?? 'unknown';
    let report;
    try {
      report = parseRunnerUsageReport(req.body?.usageReport, provider);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message }); return;
    }
    const now = new Date().toISOString();
    const completion = await recordRunnerCompletion(
      db, jobId, runner.id, provider, outcome, report, now, safeRunnerJobResult(req.body?.result), safeRunnerFailure(req.body?.failure, jobId),
    );
    if (completion !== 'written') {
      if (['completed', 'failed', 'canceled'].includes(completion)) { res.json({ jobId, status: completion, alreadyCompleted: true }); return; }
      res.status(completion === 'missing' ? 404 : 409).json({ error: 'Runner job is not completable' }); return;
    }
    outcome = (await jobRef.get()).data()!.status;
    // Un job exitoso puede liberar un handoff inmediatamente. El proceso
    // local todavía envía su heartbeat final en el `finally`, pero marcarlo
    // online acá evita que ese trigger vea el estado transitorio `busy` y
    // descarte el siguiente job aunque ya no haya ninguno activo.
    await db.collection('runners').doc(runner.id).update({ status: 'online', lastHeartbeatAt: now, updatedAt: now });
    // El workflow de GitHub libera el issue al finalizar un traspaso para que
    // el trigger despache el repo destino. El Runner local no tiene ese paso
    // de workflow: hacerlo acá evita que un `pendingRepoWork` quede detenido
    // en `claimed` después de un job exitoso.
    if (outcome === 'completed') {
      const issueRef = getFirestore().collection('issues').doc(job.issueId);
      await getFirestore().runTransaction(async (transaction) => {
        const issueSnap = await transaction.get(issueRef);
        if (!issueSnap.exists) return;
        const issue = issueSnap.data()!;
        const hasPendingHandoff = (issue.pendingRepoWork || []).some((entry: any) => !entry.dispatchedAt);
        if (hasPendingHandoff && issue.agent?.claimedBy === job.agentId) {
          transaction.update(issueRef, {
            'agent.state': 'idle',
            'agent.claimedBy': FieldValue.delete(),
            'agent.claimedAt': FieldValue.delete(),
            'agent.blockedReason': FieldValue.delete(),
            updatedAt: now,
            updatedBy: job.agentId,
          });
        }
      });
    }
    await getFirestore().collection('api_keys').where('jobId', '==', jobId).get().then((keys) => Promise.all(keys.docs.map((key) => key.ref.update({ revokedAt: now }))));
    if (job.mode === 'review') {
      const issue = await db.collection('issues').doc(job.issueId).get();
      if (issue.exists && issue.data()?.review?.state === 'running') {
        try {
          await new ReportReviewIncompleteAction({
            actionCode: 'reviews.reportIncomplete',
            data: {
              issueId: job.issueId,
              reason: outcome === 'completed'
                ? 'El Runner terminó sin que el agente QA enviara un veredicto.'
                : `El job de revisión del Runner terminó con outcome '${outcome}'.`,
            },
          }, job.agentId).run();
        } catch (error) {
          console.error(`[pulseRunnerComplete] Could not report incomplete QA review for job '${jobId}':`, error);
        }
      }
    }
    res.json({ jobId, status: outcome, completedAt: now });
  },
);
