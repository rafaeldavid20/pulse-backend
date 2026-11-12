import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { signalRunner, signalIssue, signalProfile } from '../runners/signals';

const changed = (before: any, after: any, keys: string[]) => keys.some(k => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));
export async function runnerJobSignals(before: any, after: any) {
  const db = getFirestore(); const job = after || before;
  if (!job) return;
  if (after?.status === 'pending' && before?.status !== 'pending') await signalRunner(db, after.runnerId, 'jobs');
  if (changed(before, after, ['status', 'cancelRequestedAt', 'result', 'publication', 'failure'])) await signalIssue(db, job.issueId);
}
export const runnerJobSignalsTrigger = onDocumentWritten({ document: 'runner_jobs/{jobId}', region: 'us-east4', retry: true }, e => runnerJobSignals(e.data?.before.data(), e.data?.after.data()));
export const runStatusSignalsTrigger = onDocumentWritten({ document: 'agent_runs/{runId}', region: 'us-east4', retry: true }, async e => {
  const before = e.data?.before.data(); const after = e.data?.after.data();
  // Activity lease renewals must not turn into UI/action traffic.
  if (changed(before, after, ['outcome', 'runnerOutcome', 'endedAt', 'jobId', 'activityStoppedAt'])) await signalIssue(getFirestore(), (after || before)?.issueId);
});
export const profileRequestSignalsTrigger = onDocumentWritten({ document: 'runner_profile_requests/{requestId}', region: 'us-east4', retry: true }, async e => {
  const before = e.data?.before.data(); const after = e.data?.after.data(); const request = after || before;
  if (!request) return;
  if (after?.status === 'applying' && before?.status !== 'applying') await signalRunner(getFirestore(), after.runnerId, 'profiles');
  if (changed(before, after, ['status'])) await signalProfile(getFirestore(), request.agentId);
});
export const profileSnapshotSignalsTrigger = onDocumentWritten({ document: 'runner_profiles/{profileId}', region: 'us-east4', retry: true }, async e => {
  const after = e.data?.after.data(); const before = e.data?.before.data();
  if (after || before) await signalProfile(getFirestore(), (after || before)?.agentId);
});
export const agentConfigSignalsTrigger = onDocumentWritten({ document: 'agents/{agentId}', region: 'us-east4', retry: true }, async e => {
  const before = e.data?.before.data(); const after = e.data?.after.data();
  if (!changed(before, after, ['runnerId', 'profileBinding', 'kind', 'role', 'ownerMemberId', 'visibility', 'archivedAt', 'enabled'])) return;
  const db = getFirestore();
  for (const id of new Set([before?.runnerId, after?.runnerId].filter(Boolean))) await signalRunner(db, id, 'profiles');
  await signalProfile(db, e.params.agentId);
});
async function signalWorkspace(workspaceId?: string) {
  if (!workspaceId) return;
  const db = getFirestore();
  const runners = await db.collection('runners').where('workspaceId', '==', workspaceId).get();
  await Promise.all(runners.docs.filter(r => !r.data().revokedAt).map(r => signalRunner(db, r.id, 'profiles')));
}
export const projectAccessSignalsTrigger = onDocumentWritten({ document: 'projects/{projectId}', region: 'us-east4', retry: true }, async e => {
  const before = e.data?.before.data(); const after = e.data?.after.data();
  if (changed(before, after, ['workspaceId', 'repoFullNames'])) for (const ws of new Set([before?.workspaceId, after?.workspaceId])) await signalWorkspace(ws);
});
export const installationAccessSignalsTrigger = onDocumentWritten({ document: 'github_installations/{installationId}', region: 'us-east4', retry: true }, async e => {
  const before = e.data?.before.data(); const after = e.data?.after.data();
  if (changed(before, after, ['workspaceId', 'repositoryFullNames', 'suspendedAt'])) for (const ws of new Set([before?.workspaceId, after?.workspaceId])) await signalWorkspace(ws);
});
