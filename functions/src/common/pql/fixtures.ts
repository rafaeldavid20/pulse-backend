// GENERATED from pulse-app/src/lib/pql; do not edit.
import type { Context } from './resolver';

/** Portable corpus for consumers of the generated backend copy. */
export const fixtureContext: Context = {
  workspaceId: 'fixture', actorId: 'user-a', now: '2024-01-31T12:00:00Z', teamId: 'team-a',
  members: [{ id: 'member-a', userId: 'user-a', displayName: 'Ada' }, { id: 'member-b', userId: 'user-b', displayName: 'Bob' }],
  teams: [{ id: 'team-a', key: 'TES', name: 'Equipo' }],
  projects: [{ id: 'project-a', name: 'Proyecto' }],
  labels: [{ id: 'label-a', name: 'backend' }, { id: 'label-b', name: 'urgente' }],
  cycles: [{ id: 'cycle-a', name: 'Ciclo', teamId: 'team-a', status: 'active', endsAt: '2024-02-29T12:00:00Z' }],
  issues: [{ id: 'epic-a', identifier: 'TES-122', type: 'epic' }, { id: 'issue-a', identifier: 'TES-123', type: 'story' }],
};
export const fixtureIssues = [
  { id: 'epic-a', identifier: 'TES-122', title: 'Épica', type: 'epic', teamId: 'team-a', status: 'todo', priority: 0, assigneeId: 'user-a', labelIds: ['label-a'], createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-30T00:00:00Z' },
  { id: 'issue-a', identifier: 'TES-123', title: 'Backend', type: 'story', epicId: 'epic-a', parentId: 'epic-a', teamId: 'team-a', status: 'in_progress', priority: 1, assigneeId: 'user-a', labelIds: ['label-b'], cycleId: 'cycle-a', dueDate: '2024-02-29T12:00:00Z', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-30T00:00:00Z', review: { state: 'approved', reviewerId: 'user-b', verdict: 'Bien' } },
  { id: 'issue-b', identifier: 'TES-124', title: 'Otra tarea', teamId: 'team-a', status: 'done', priority: 2, labelIds: [], createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-25T00:00:00Z' },
];
export const fixtureCases = [
  { query: '', ids: ['issue-b', 'issue-a', 'epic-a'] },
  { query: 'epic = TES-122 AND assignee = me() ORDER BY priority ASC', ids: ['issue-a', 'epic-a'] },
  { query: 'label NOT IN (backend, urgente)', ids: ['issue-b'] },
  { query: 'assignee IS EMPTY OR review.state = approved', ids: ['issue-b', 'issue-a'] },
  { query: 'cycle = currentCycle() AND due = endOfCycle()', ids: ['issue-a'] },
  { query: 'due = +1m', ids: ['issue-a'] },
  { query: 'updated > -7d ORDER BY updated DESC, priority ASC', ids: ['issue-a', 'epic-a', 'issue-b'] },
  { query: 'type = task', ids: ['issue-b'] },
  { query: 'review.reviewer = Bob AND review.verdict ~ "bien"', ids: ['issue-a'] },
  { query: 'unknown = 1', code: 'FIELD', start: 0, end: 11 },
  { query: 'status IN ()', code: 'SYNTAX', start: 11, end: 12 },
  { query: 'assignee = Desconocido', code: 'REFERENCE', start: 11, end: 22 },
] as const;
