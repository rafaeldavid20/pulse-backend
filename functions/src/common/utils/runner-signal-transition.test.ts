import test from 'node:test';
import assert from 'node:assert/strict';
import { runnerAvailabilityRestored } from './runner-signal-transition';
test('QA wakes on recovered availability/preparation, never on routine idle heartbeats',()=>{
  const now=Date.now();const ready={status:'online',lastHeartbeatAt:new Date(now).toISOString(),readinessCheckedAt:new Date(now).toISOString(),readiness:{providers:{codex:{session:true}}}};
  const prior={...ready,lastHeartbeatAt:new Date(now-60_000).toISOString(),readinessCheckedAt:new Date(now-60_000).toISOString()};
  assert.equal(runnerAvailabilityRestored(prior,ready,now),false);
  for(const before of [{...prior,status:'offline'},{...prior,lastHeartbeatAt:new Date(now-180_000).toISOString()},{...prior,readinessCheckedAt:new Date(now-180_000).toISOString()},{...prior,readiness:{providers:{codex:{session:false}}}}]) assert.equal(runnerAvailabilityRestored(before,ready,now),true);
  assert.equal(runnerAvailabilityRestored(prior,{...ready,revokedAt:'now'},now),false);
  assert.equal(runnerAvailabilityRestored(prior,{...ready,readiness:undefined},now),false);
});
