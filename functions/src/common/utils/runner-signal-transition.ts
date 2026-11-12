import { isRunnerAvailable, RUNNER_HEARTBEAT_TTL_MS } from './runner-availability';
const fresh = (runner: any, now: number) => {
  const at = Date.parse(runner?.readinessCheckedAt || '');
  return !!runner?.readiness && Number.isFinite(at) && at <= now && now - at <= RUNNER_HEARTBEAT_TTL_MS;
};
/** Heartbeat timestamp renewal alone never scans the pending QA queue. */
export function runnerAvailabilityRestored(before: any, after: any, now = Date.now()) {
  return !!after && isRunnerAvailable(after, now) && fresh(after, now)
    && (!before || !isRunnerAvailable(before, now) || !fresh(before, now)
      || JSON.stringify(before.readiness) !== JSON.stringify(after.readiness));
}
