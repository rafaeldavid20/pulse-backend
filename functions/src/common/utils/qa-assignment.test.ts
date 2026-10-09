import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { qaAssignmentError } from './qa-assignment';

const qa = { workspaceId: 'ws', role: 'qa', enabled: true, runnerId: 'runner-1', reviewRepo: 'owner/repo', autonomousMode: false };
test('manual QA can review without autonomous mode', () => {
  assert.equal(qaAssignmentError('qa', qa, 'ws', 'dev', 'owner/repo'), undefined);
});
test('project-scoped Runner QA does not require a per-repository reviewRepo', () => {
  assert.equal(qaAssignmentError('qa-codex', { ...qa, reviewRepo: undefined, runnerId: 'runner-1' }, 'ws', 'dev', 'owner/repo'), undefined);
});
test('development agent cannot review its own issue', () => {
  assert.match(qaAssignmentError('dev', qa, 'ws', 'dev', 'owner/repo')!, /mismo agente/);
});
test('manual QA must match workspace, role, enabled state and review repo', () => {
  for (const invalid of [undefined, { ...qa, workspaceId: 'other' }, { ...qa, role: 'dev' },
    { ...qa, enabled: false }, { ...qa, archivedAt: 'now' }, { ...qa, runnerId: undefined }]) {
    assert.ok(qaAssignmentError('qa', invalid, 'ws', 'dev', 'owner/repo'));
  }
  assert.equal(qaAssignmentError('qa', qa, 'ws', 'dev', undefined), undefined);
  assert.ok(qaAssignmentError('qa', { ...qa, runnerId: undefined, reviewRepo: undefined }, 'ws', 'dev', 'owner/repo'));
});

test('a retired QA repo connection cannot replace a local Runner', () => {
  assert.match(qaAssignmentError('qa', { ...qa, runnerId: undefined }, 'ws', 'dev', 'owner/repo')!, /Runner local/);
});
