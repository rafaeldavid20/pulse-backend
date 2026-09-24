import { getFirestore } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

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
  console.log(`[RunnerJobs] expired ${expired.length} jobs.`);
});
