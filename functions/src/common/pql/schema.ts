// GENERATED from pulse-app/src/lib/pql; do not edit.
/** The complete PQL v1 field registry. This module has no runtime dependencies. */
export type FieldType = 'enum' | 'number' | 'date' | 'reference' | 'set' | 'text';
export interface FieldSpec { type: FieldType; path: string; values?: readonly string[]; sortable: boolean }
export const fields: Record<string, FieldSpec> = {
  status: { type: 'enum', path: 'status', values: ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'], sortable: true },
  priority: { type: 'number', path: 'priority', sortable: true },
  type: { type: 'enum', path: 'type', values: ['epic', 'story', 'task', 'bug', 'subtask'], sortable: true },
  estimate: { type: 'number', path: 'estimate', sortable: true },
  assignee: { type: 'reference', path: 'assigneeId', sortable: true },
  creator: { type: 'reference', path: 'creatorId', sortable: true },
  project: { type: 'reference', path: 'projectId', sortable: true },
  parent: { type: 'reference', path: 'parentId', sortable: true },
  team: { type: 'reference', path: 'teamId', sortable: true },
  cycle: { type: 'reference', path: 'cycleId', sortable: true },
  label: { type: 'set', path: 'labelIds', sortable: false },
  epic: { type: 'reference', path: 'epicId', sortable: false },
  created: { type: 'date', path: 'createdAt', sortable: true },
  updated: { type: 'date', path: 'updatedAt', sortable: true },
  due: { type: 'date', path: 'dueDate', sortable: true },
  'agent.state': { type: 'enum', path: 'agent.state', values: ['idle', 'claimed', 'working', 'pr_open', 'blocked'], sortable: true },
  'git.prstate': { type: 'enum', path: 'git.prState', values: ['open', 'draft', 'merged', 'closed'], sortable: true },
  'review.state': { type: 'enum', path: 'review.state', values: ['pending', 'running', 'approved', 'changes_requested', 'needs_human', 'stale'], sortable: true },
  'review.reviewer': { type: 'reference', path: 'review.reviewerId', sortable: true },
  'review.verdict': { type: 'text', path: 'review.verdict', sortable: false },
  text: { type: 'text', path: 'title', sortable: false },
};

export function operatorsFor(type: FieldType): readonly string[] {
  if (type === 'text') return ['=', '!=', '~', 'is empty', 'is not empty'];
  if (type === 'number' || type === 'date') return ['=', '!=', '<', '<=', '>', '>=', 'in', 'not in', 'is empty', 'is not empty'];
  return ['=', '!=', 'in', 'not in', 'is empty', 'is not empty'];
}
