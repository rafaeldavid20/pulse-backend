import test from 'node:test';
import assert from 'node:assert/strict';
import { filterUnarchivedAgents } from './agent-lifecycle';

test('los agentes archivados no aparecen como opciones para asignación', () => {
  const active = { id: 'active', displayName: 'Disponible' };
  const archived = { id: 'archived', displayName: 'Histórico', archivedAt: '2026-10-01T00:00:00.000Z' };
  assert.deepEqual(filterUnarchivedAgents([active, archived]), [active]);
});
