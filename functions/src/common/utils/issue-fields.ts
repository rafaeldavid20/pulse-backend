/**
 * Single source of truth for which `Issue` fields a caller (client SDK
 * fallback, MCP tool, or Platform Action request) is allowed to set.
 *
 * Kept in sync with `pulse-app/src/lib/constants/issue.ts`'s
 * `ISSUE_WRITABLE_FIELDS` — both exist because the frontend and the
 * functions codebase are separate TypeScript projects and don't share
 * imports across the `pulse-app`/`pulse-backend` repo boundary.
 *
 * Deliberately a whitelist, not a blind spread: request data can come from
 * an MCP tool call driven by an LLM, and a spread would let it set
 * server-owned fields like `id`, `identifier`, `creatorId` or `workspaceId`.
 *
 * `id`, `identifier`, `number`, `workspaceId`, `teamId`, `creatorId`,
 * `createdAt`, `updatedAt` are deliberately excluded — those are always
 * server-assigned and set explicitly by each action, never taken from the
 * caller's payload.
 */
export const ISSUE_WRITABLE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'projectId',
  'assigneeId',
  'labelIds',
  'parentId',
  'dueDate',
  'estimate',
] as const;

export type IssueWritableField = (typeof ISSUE_WRITABLE_FIELDS)[number];

/**
 * Returns a shallow copy of `source` containing only the keys listed in
 * `fields` that are actually present on `source` (so omitted fields don't
 * become explicit `undefined` keys that later need cleaning).
 */
export function pickWritableFields<T extends Record<string, any>>(
  source: T,
  fields: readonly string[]
): Partial<T> {
  const picked: Partial<T> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      (picked as Record<string, any>)[field] = source[field];
    }
  }
  return picked;
}
