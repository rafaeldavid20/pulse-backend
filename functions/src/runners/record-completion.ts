import { Firestore } from 'firebase-admin/firestore';
import { RunnerUsageReport } from '../common/utils/runner-usage';

export async function recordRunnerCompletion(
  db: Firestore, jobId: string, runnerId: string, provider: 'claude' | 'codex',
  outcome: 'completed' | 'failed' | 'canceled', report: RunnerUsageReport, now: string,
): Promise<'written' | 'missing' | 'expired' | 'mismatch' | 'completed' | 'failed' | 'canceled'> {
  const jobRef = db.collection('runner_jobs').doc(jobId);
  const runRef = db.collection('agent_runs').doc(jobId);
  return db.runTransaction(async (transaction) => {
    const [jobSnap, runSnap] = await Promise.all([transaction.get(jobRef), transaction.get(runRef)]);
    if (!jobSnap.exists || jobSnap.data()!.runnerId !== runnerId) return 'missing';
    const job = jobSnap.data()!;
    if (['completed', 'failed', 'canceled'].includes(job.status)) return job.status;
    if (job.status !== 'delivered' || new Date(job.expiresAt).getTime() <= Date.now()) return 'expired';
    if (!runSnap.exists || runSnap.data()!.workspaceId !== job.workspaceId || runSnap.data()!.issueId !== job.issueId || runSnap.data()!.agentId !== job.agentId || runSnap.data()!.runnerId !== runnerId) return 'mismatch';
    transaction.update(jobRef, { status: outcome, completedAt: now });
    transaction.update(runRef, {
      provider, runnerOutcome: outcome, usage: report.usage,
      ...(report.costUsd === undefined ? {} : { costUsd: report.costUsd }),
    });
    return 'written';
  });
}
