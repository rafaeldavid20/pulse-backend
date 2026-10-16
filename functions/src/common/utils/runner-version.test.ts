import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerReleaseLookup, fetchRunnerRelease, runnerProcessReport, runnerUpdateStatus, runnerReleaseChangesUrl, safeRunnerVersion, RunnerRelease, RELEASE_TTL_MS, RELEASE_RETRY_MS, RUNNER_REGISTRY_URL } from './runner-version';
const now = Date.parse('2026-10-15T12:00:00Z');
const stable: RunnerRelease = { status: 'available', version: '0.1.19', checkedAt: new Date(now).toISOString(), nextCheckAt: now + RELEASE_TTL_MS };

test('strict semver: older, equal, newer, prereleases and malformed versions', () => {
  for (const version of ['0.1.9', '0.1.17', '0.1.19-rc.1']) assert.equal(runnerUpdateStatus(version, stable), 'update_available');
  for (const version of ['0.1.19', '0.1.20', '0.1.20-dev.1', '0.1.19+build.1']) assert.equal(runnerUpdateStatus(version, stable), 'current');
  for (const version of [null, undefined, 'garbage', '01.1.1', 'v0.1.19', '0.1', '0.1.19-01']) {
    assert.equal(safeRunnerVersion(version), null);
    assert.equal(runnerUpdateStatus(version, stable), 'unknown');
  }
});

test('heartbeat is the only source of process metadata; legacy heartbeat clears prior reports', () => {
  const first = runnerProcessReport({ processVersion: '0.1.17', localPath: 'private' }, stable.checkedAt);
  assert.equal(first.usageReportSupported, false);
  assert.equal(runnerUpdateStatus(first.processVersion, stable), 'update_available');
  const restarted = runnerProcessReport({ processVersion: '0.1.19', capabilities: { usageReport: true, private: 'secret' } }, new Date(now + 1000).toISOString());
  assert.equal(runnerUpdateStatus(restarted.processVersion, stable), 'current');
  assert.equal(restarted.usageReportSupported, true);
  assert.equal(JSON.stringify(restarted).includes('secret'), false);
  assert.deepEqual(runnerProcessReport({}, stable.checkedAt), { processVersion: null, versionReportedAt: stable.checkedAt, usageReportSupported: null });
  assert.equal(runnerProcessReport({processVersion:'invalid'},stable.checkedAt).processVersion,null);
});

test('registry uses official latest, timeout and no redirects; invalid latest/failure never recommends prereleases', async () => {
  let url: unknown; let signal: AbortSignal | undefined;
  const fetcher = (async (input, init) => { url = input; signal = init?.signal as AbortSignal; assert.equal(init?.redirect, 'error'); return new Response(JSON.stringify({ version: '0.1.19' })); }) as typeof fetch;
  assert.deepEqual(await fetchRunnerRelease(fetcher, now), stable);
  assert.equal(url, RUNNER_REGISTRY_URL); assert.ok(signal);
  for (const version of ['0.2.0-beta.1', 'oops', undefined]) {
    const result = await fetchRunnerRelease((async () => new Response(JSON.stringify({ version }))) as typeof fetch, now);
    assert.equal(result.status, 'unavailable');
    assert.equal(runnerUpdateStatus('0.1.17', result), 'unavailable');
  }
  const failed = await fetchRunnerRelease((async () => { throw new Error('timeout'); }) as typeof fetch, now);
  assert.equal(failed.nextCheckAt, now + RELEASE_RETRY_MS);
});

test('coalesces concurrent users/rows, caches success and failure, expires and recovers with controlled clock', async () => {
  let clock = now; let stored: RunnerRelease | undefined; let count = 0; let fail = false;
  const cache = {
    async claim(time: number) { return { claimed: !stored || stored.nextCheckAt <= time, release: stored }; },
    async save(release: RunnerRelease) { stored = release; },
  };
  const lookup = createRunnerReleaseLookup(cache, (async () => { count++; if (fail) throw Error('offline'); return new Response('{"version":"0.1.19"}'); }) as typeof fetch, () => clock);
  const results = await Promise.all(Array.from({length:20}, () => lookup()));
  assert.equal(count, 1); assert.ok(results.every(r => r.version === '0.1.19'));
  await lookup(); assert.equal(count,1);
  clock += RELEASE_TTL_MS; fail = true;
  assert.equal((await lookup()).status, 'unavailable'); assert.equal(count,2);
  await lookup(); assert.equal(count,2);
  clock += RELEASE_RETRY_MS; fail=false;
  assert.equal((await lookup()).status,'available'); assert.equal(count,3);
});

test('cross-instance lease returns honest unavailable while refreshing expired data', async () => {
  const lookup = createRunnerReleaseLookup({ async claim() {return {claimed:false, release: {...stable, nextCheckAt:now-1}};}, async save() {assert.fail();} }, (async () => {assert.fail();}) as typeof fetch, () => now);
  assert.equal((await lookup()).status,'unavailable');
});

test('changes link uses stable publication tags only', () => {
  assert.equal(runnerReleaseChangesUrl('0.1.17', stable), 'https://github.com/rafaeldavid20/pulse-runner/compare/v0.1.17...v0.1.19');
  for (const version of [null,'0.1.20-dev.1','0.1.17-beta.1','0.1.17+custom']) assert.equal(runnerReleaseChangesUrl(version,stable),null);
});
