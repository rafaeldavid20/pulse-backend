import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { RUNNER_HEARTBEAT_TTL_MS } from '../common/utils/runner-availability';

/** Expira jobs no terminados y revoca sus credenciales MCP temporales. */
export const runnerJobSweeperScheduled = onSchedule({ region: 'us-east4', schedule: 'every 5 minutes' }, async () => {
  const db = getFirestore();
  const now = new Date().toISOString();
  const jobs = await db.collection('runner_jobs').get();
  const expired = jobs.docs.filter((job) => ['pending', 'delivered'].includes(job.data().status) && job.data().expiresAt <= now);
  await Promise.all(expired.map(async (job) => {
    await job.ref.update({ status: 'expired', expiredAt: now });
    const keys = await db.collection('api_keys').where('jobId', '==', job.id).get();
    await Promise.all(keys.docs.map((key) => key.ref.update({ revokedAt: now })));
  }));
  // Las claves de Runner son material efímero: una vez revocadas o vencidas,
  // el registro de job permanece para auditoría pero la clave se elimina.
  const keys = await db.collection('api_keys').get();
  const keyCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const disposableKeys = keys.docs.filter((key) => {
    const data = key.data();
    if (!data.jobId) return false;
    const expiry = new Date(data.expiresAt || data.revokedAt || 0).getTime();
    return Number.isFinite(expiry) && expiry < keyCutoff;
  });
  await Promise.all(disposableKeys.map((key) => key.ref.delete()));

  const runnerCutoff = Date.now() - RUNNER_HEARTBEAT_TTL_MS;
  const runners = await db.collection('runners').where('status', '==', 'online').get();
  const staleRunners = runners.docs.filter((runner) => {
    const heartbeat = new Date(runner.data().lastHeartbeatAt || 0).getTime();
    return !Number.isFinite(heartbeat) || heartbeat < runnerCutoff;
  });
  await Promise.all(staleRunners.map((runner) => runner.ref.update({ status: 'offline', updatedAt: now })));
  console.log(`[RunnerJobs] expired ${expired.length} jobs, deleted ${disposableKeys.length} temporary keys, marked ${staleRunners.length} stale Runners offline.`);
});
