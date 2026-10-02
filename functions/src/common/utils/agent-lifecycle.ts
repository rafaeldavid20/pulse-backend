/** Agentes archivados se conservan para auditoría, pero no se ofrecen para asignaciones. */
export function filterUnarchivedAgents<T extends object>(agents: T[]): T[] {
  return agents.filter((agent) => !(agent as { archivedAt?: unknown }).archivedAt);
}
