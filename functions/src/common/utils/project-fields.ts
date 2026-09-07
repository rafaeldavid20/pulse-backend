/**
 * Same rationale as `ISSUE_WRITABLE_FIELDS` (issue-fields.ts): a whitelist,
 * not a blind spread of the update payload — `update-project.ts` used to
 * spread `data` directly, which would let a caller overwrite `id`,
 * `workspaceId` or `teamId` on an existing project.
 */
export const PROJECT_WRITABLE_FIELDS = [
  'name',
  'description',
  'status',
  'leadId',
  'color',
  'targetDate',
] as const;

export type ProjectWritableField = (typeof PROJECT_WRITABLE_FIELDS)[number];
