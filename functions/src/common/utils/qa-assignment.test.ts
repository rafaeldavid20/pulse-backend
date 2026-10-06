import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { qaAssignmentError } from './qa-assignment';

const qa = { workspaceId: 'ws', role: 'qa', enabled: true, reviewRepo: 'owner/repo', autonomousMode: false };
test('manual QA can review without autonomous mode', () => {
  assert.equal(qaAssignmentError('qa', qa, 'ws', 'dev', 'owner/repo'), undefined);
});
test('development agent cannot review its own issue', () => {
  assert.match(qaAssignmentError('dev', qa, 'ws', 'dev', 'owner/repo')!, /mismo agente/);
});
test('manual QA must match workspace, role, enabled state and review repo', () => {
  for (const invalid of [undefined, { ...qa, workspaceId: 'other' }, { ...qa, role: 'dev' },
    { ...qa, enabled: false }, { ...qa, archivedAt: 'now' }, { ...qa, reviewRepo: 'other/repo' }]) {
    assert.ok(qaAssignmentError('qa', invalid, 'ws', 'dev', 'owner/repo'));
  }
  assert.ok(qaAssignmentError('qa', qa, 'ws', 'dev', undefined));
});
