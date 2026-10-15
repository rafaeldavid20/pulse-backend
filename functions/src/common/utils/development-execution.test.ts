import test from 'node:test';
import assert from 'node:assert/strict';
import { activeDevelopmentJob, developmentState, hasExecutionLease } from './development-execution';
const now = Date.parse('2026-10-15T12:00:00Z');

test('historical claims and rework marks never imply execution', () => {
  const issue = { agent: { state: 'claimed', claimedAt: '2026-10-15T11:59:59Z' }, review: { reworkDispatchedForAttempt: 1 } };
  assert.equal(hasExecutionLease(issue, [], now), false);
  assert.equal(developmentState(issue, [], [], now).state, 'idle');
});
test('expired pending jobs are failures rather than completed work', () => {
  const state = developmentState({}, [{ id: 'old', mode: 'rework', status: 'delivered', expiresAt: '2026-10-15T11:00:00Z' }], [], now);
  assert.equal(state.state, 'failed'); assert.equal(state.jobStatus, 'expired'); assert.equal(state.active, false);
});
test('unknown expiry is conservative and a host lease takes precedence over queue state', () => {
  assert.equal(activeDevelopmentJob({ status: 'delivered' }, now), true);
  const state = developmentState({}, [{ id: 'live', status: 'delivered' }], [{ role: 'dev', activityExpiresAt: '2026-10-15T12:01:00Z' }], now);
  assert.equal(state.state, 'running'); assert.equal(state.active, true);
});
