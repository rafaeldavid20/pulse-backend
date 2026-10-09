/** A renewable lease, never the issue status or the assignment. */
export const RUN_ACTIVITY_TTL_MS = 120_000;
export function activityLease(run: { activityExpiresAt?: string; activityStoppedAt?: string; endedAt?: string; outcome?: string; runnerOutcome?: string; role?: string }, now = Date.now()) {
  const expiry = Date.parse(run.activityExpiresAt || '');
  if (run.activityStoppedAt || run.endedAt || run.outcome || run.runnerOutcome || !Number.isFinite(expiry) || expiry <= now) return null;
  return { ...(run.role === 'dev' || run.role === 'qa' ? { role: run.role } : {}), expiresAt: new Date(expiry).toISOString() };
}
