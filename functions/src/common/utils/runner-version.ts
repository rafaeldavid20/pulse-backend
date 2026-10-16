import { valid, prerelease, gt, lt } from 'semver';

export function safeRunnerVersion(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 100 && valid(value) !== null && /^[0-9]/.test(value) && !/\s/.test(value) ? value : null;
}

/** Every heartbeat replaces the process report, including legacy/malformed reports. */
export function runnerProcessReport(body: any, now: string) {
  const processVersion = safeRunnerVersion(body?.processVersion);
  return { processVersion, versionReportedAt: now,
    usageReportSupported: typeof body?.capabilities?.usageReport === 'boolean'
      ? body.capabilities.usageReport
      : processVersion && !prerelease(processVersion) && lt(processVersion, '0.1.19') ? false : null };
}

export interface RunnerRelease {
  status: 'available' | 'unavailable';
  version?: string;
  checkedAt: string;
  nextCheckAt: number;
}

export function runnerUpdateStatus(version: unknown, release: RunnerRelease) {
  const current = safeRunnerVersion(version);
  if (!current) return 'unknown' as const;
  if (release.status !== 'available' || !release.version) return 'unavailable' as const;
  return gt(release.version, current) ? 'update_available' as const : 'current' as const;
}

/** Release automation tags stable npm publications; compare only known release-shaped tags. */
export function runnerReleaseChangesUrl(version: unknown, release: RunnerRelease): string | null {
  const current = safeRunnerVersion(version);
  return current && !prerelease(current) && !current.includes('+') && runnerUpdateStatus(current, release) === 'update_available'
    ? `https://github.com/rafaeldavid20/pulse-runner/compare/v${current}...v${release.version}` : null;
}

export const RELEASE_TTL_MS = 15 * 60_000;
export const RELEASE_RETRY_MS = 60_000;
export const REGISTRY_TIMEOUT_MS = 3000;
export const RUNNER_REGISTRY_URL = 'https://registry.npmjs.org/@pulsehub%2Frunner/latest';

export async function fetchRunnerRelease(fetcher: typeof fetch = fetch, now = Date.now()): Promise<RunnerRelease> {
  const checkedAt = new Date(now).toISOString();
  try {
    const response = await fetcher(RUNNER_REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) throw new Error('Registry unavailable');
    const data = await response.json() as { version?: unknown };
    const version = safeRunnerVersion(data.version);
    if (!version || prerelease(version)) throw new Error('Invalid stable version');
    return { status: 'available', version, checkedAt, nextCheckAt: now + RELEASE_TTL_MS };
  } catch {
    return { status: 'unavailable', checkedAt, nextCheckAt: now + RELEASE_RETRY_MS };
  }
}

export interface ReleaseCache {
  claim(now: number): Promise<{ claimed: boolean; release?: RunnerRelease }>;
  save(release: RunnerRelease): Promise<void>;
}

/** The shared store leases refreshes across instances; this promise coalesces local callers. */
export function createRunnerReleaseLookup(cache: ReleaseCache, fetcher: typeof fetch = fetch, clock = Date.now) {
  let pending: Promise<RunnerRelease> | undefined;
  return (): Promise<RunnerRelease> => {
    if (pending) return pending;
    pending = (async () => {
      const now = clock();
      const { claimed, release } = await cache.claim(now);
      if (!claimed) return release && release.nextCheckAt > now ? release
        : { status: 'unavailable' as const, checkedAt: new Date(now).toISOString(), nextCheckAt: now + RELEASE_RETRY_MS };
      const fresh = await fetchRunnerRelease(fetcher, now);
      await cache.save(fresh);
      return fresh;
    })().catch(() => ({ status: 'unavailable' as const, checkedAt: new Date(clock()).toISOString(), nextCheckAt: clock() + RELEASE_RETRY_MS }))
      .finally(() => { pending = undefined; });
    return pending;
  };
}
