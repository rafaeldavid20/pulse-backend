import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { activityLease } from '../common/utils/run-activity';

/** Re-read inside a transaction: duplicate/out-of-order events cannot resurrect a closed run. */
export async function projectRunActivity(runId: string) {
  const db = getFirestore();
  await db.runTransaction(async tx => {
    const run = (await tx.get(db.collection('agent_runs').doc(runId))).data();
    if (!run?.issueId) return;
    const issueRef = db.collection('issues').doc(run.issueId);
    const issue = (await tx.get(issueRef)).data();
    if (!issue || issue.workspaceId !== run.workspaceId) return;
    let lease = activityLease(run);
    if (run.runnerId) {
      const job = (await tx.get(db.collection('runner_jobs').doc(runId))).data();
      if (!job || job.workspaceId !== run.workspaceId || job.issueId !== run.issueId || job.agentId !== run.agentId || job.runnerId !== run.runnerId || job.status !== 'delivered' || job.cancelRequestedAt || job.publication || job.recoveryOf || !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= Date.now()) lease = null;
    }
    const entries: Record<string, unknown> = Object.fromEntries(Object.entries(issue.agentActivity || {}).filter(([, entry]) => Date.parse((entry as { expiresAt: string }).expiresAt) > Date.now()));
    if (lease) entries[runId] = lease;
    else delete entries[runId];
    if (JSON.stringify(issue.agentActivity || {}) !== JSON.stringify(entries)) {
      tx.update(issueRef, { agentActivity: entries });
    }
  });
}
export const runActivityTrigger = onDocumentWritten({ document: 'agent_runs/{runId}', region: 'us-east4' }, async event => {
  if (!event.data?.after.exists) {
    const before = event.data?.before.data();
    if (before?.issueId) await getFirestore().collection('issues').doc(before.issueId).update({ [`agentActivity.${event.params.runId}`]: FieldValue.delete() });
    return;
  }
  await projectRunActivity(event.params.runId);
});
export const runnerJobActivityTrigger = onDocumentWritten({ document: 'runner_jobs/{jobId}', region: 'us-east4' }, async event => {
  await projectRunActivity(event.params.jobId);
});
