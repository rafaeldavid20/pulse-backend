/** Manual QA must remain independent from the development agent. */
export function qaAssignmentError(
  agentId: string,
  agent: Record<string, any> | undefined,
  workspaceId: string,
  executionAgentId: string | undefined,
  repoFullName: string | undefined,
): string | undefined {
  if (!agent || agent.workspaceId !== workspaceId || agent.role !== 'qa' || !agent.enabled || agent.archivedAt) {
    return 'El agente QA debe estar habilitado, pertenecer a este workspace y tener rol QA.';
  }
  if (agentId === executionAgentId) {
    return 'El agente QA no puede ser el mismo agente que ejecuta el issue. Elegí otro agente QA.';
  }
  if (!repoFullName || agent.reviewRepo !== repoFullName) {
    return 'El agente QA no está configurado para revisar el repo del issue. Configurá su repo a revisar o elegí otro QA.';
  }
  return undefined;
}
