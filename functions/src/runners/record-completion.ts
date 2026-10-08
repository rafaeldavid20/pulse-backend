import { RunnerFailure } from '../common/utils/runner-result';
import { Firestore } from 'firebase-admin/firestore';
import { RunnerUsageReport } from '../common/utils/runner-usage';

export async function recordRunnerCompletion(
  db: Firestore, jobId: string, runnerId: string, provider: string,
  outcome: 'completed' | 'failed' | 'canceled', report: RunnerUsageReport, now: string, result: string | null = null, failure: RunnerFailure | null = null, publication: ReturnType<typeof import('../common/utils/runner-publication').parsePublication> = null,
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
    if (job.protocolVersion === 3 && outcome === 'completed' && !publication) throw new Error('Missing publication report.');
    if (publication && publication.repositories.some((e: any) => e.stage === 'linked' && !job.linkedPublications?.some((p: any) => p.repoFullName === e.repo && p.sha === e.sha && p.prNumber === e.prNumber))) throw new Error('Publication link was not recorded.');
    if (publication && outcome === 'completed' && (publication.execution !== 'completed' || publication.repositories.some((e: any) => e.stage !== 'linked'))) throw new Error('Publication is incomplete.');
    const finalOutcome = job.cancelRequestedAt ? 'canceled' : outcome;
    transaction.update(jobRef, { ...(publication ? {publication} : {}), status: finalOutcome, completedAt: now, result, failure: finalOutcome === 'canceled' ? null : failure });
    transaction.update(runRef, {
      provider, runnerOutcome: finalOutcome, usage: report.usage,
      ...(report.costUsd === undefined ? {} : { costUsd: report.costUsd }),
    });
    return 'written';
  });
}
