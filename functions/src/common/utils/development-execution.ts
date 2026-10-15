import { activityLease } from './run-activity';

/** An unknown job expiry is conservatively live. Historical claims are not leases. */
export function activeDevelopmentJob(job: any, now = Date.now()): boolean {
  return ['pending', 'delivered'].includes(job.status) && (!Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) > now);
}
export function hasExecutionLease(issue: any, runs: any[], now = Date.now()): boolean {
  return Object.values(issue.agentActivity || {}).some((entry: any) => !Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) > now) || runs.some(run => activityLease(run, now));
}
export function developmentState(issue: any, jobs: any[], runs: any[], now = Date.now()) {
  const ordered = [...jobs].sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  const live = ordered.find(job => activeDevelopmentJob(job, now));
  const latest = live || ordered.find(job => job.mode !== 'review');
  const expired = latest && ['pending', 'delivered'].includes(latest.status) && !activeDevelopmentJob(latest, now);
  const state = hasExecutionLease(issue, runs, now) ? 'running' : live ? 'queued' : latest && (expired || ['failed', 'expired', 'canceled'].includes(latest.status)) ? 'failed' : latest ? 'completed' : issue.agent?.state === 'blocked' ? 'failed' : 'idle';
  return { state, ...(latest ? { jobId: latest.id, jobStatus: expired ? 'expired' : latest.status } : {}), active: state === 'running' || state === 'queued' };
}
