/** A Runner must keep an active heartbeat; an old "online" flag is not enough. */
export const RUNNER_HEARTBEAT_TTL_MS = 2 * 60 * 1000;

export function isRunnerAvailable(runner: { status?: string; revokedAt?: string | null; lastHeartbeatAt?: string }, now = Date.now()): boolean {
  if (runner.status !== 'online' || runner.revokedAt || !runner.lastHeartbeatAt) return false;
  const heartbeat = new Date(runner.lastHeartbeatAt).getTime();
  return Number.isFinite(heartbeat) && heartbeat <= now && now - heartbeat <= RUNNER_HEARTBEAT_TTL_MS;
}
