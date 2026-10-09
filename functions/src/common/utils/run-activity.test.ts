import test from 'node:test';
import assert from 'node:assert/strict';
import { activityLease } from './run-activity';
const now = Date.parse('2026-10-09T12:00:00Z');
const live = { activityExpiresAt: '2026-10-09T12:01:00Z', role: 'dev' };
test('only a fresh host lease implies activity; dispatch or assignment never does', () => {
  assert.equal(activityLease({}, now), null);
  assert.equal(activityLease({ activityExpiresAt: 'invalid' }, now), null);
  assert.equal(activityLease({ activityExpiresAt: '2026-10-09T12:00:00Z' }, now), null);
  assert.deepEqual(activityLease(live, now), { role: 'dev', expiresAt: '2026-10-09T12:01:00.000Z' });
  assert.equal(activityLease({ ...live, role: 'qa' }, now)?.role, 'qa');
  assert.deepEqual(activityLease({ ...live, role: 'unknown' }, now), { expiresAt: '2026-10-09T12:01:00.000Z' });
});
test('every terminal run removes activity even with a fresh lease', () => {
  for (const outcome of ['pr_opened', 'verdict_submitted', 'released', 'ambiguous', 'failed', 'timeout']) assert.equal(activityLease({ ...live, outcome }, now), null);
  for (const runnerOutcome of ['completed', 'failed', 'canceled']) assert.equal(activityLease({ ...live, runnerOutcome }, now), null);
  assert.equal(activityLease({ ...live, activityStoppedAt: '2026-10-09T12:00:00Z' }, now), null);
  assert.equal(activityLease({ ...live, endedAt: '2026-10-09T12:00:00Z' }, now), null);
});
