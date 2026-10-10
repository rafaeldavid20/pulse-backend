import { agentVisibility, isWorkspaceAdmin } from './agent-authorization';
import { validBranch } from './runner-publication';

/** Rechecked within the enqueue transaction; a human request grants no new scope. */
export function assertHumanReworkRequester(callerUid: string, member: any, agent: any, issue: any): void {
  if (!member || member.isAgent === true) throw new Error('Solo una persona del workspace puede solicitar una corrección.');
  if (agentVisibility(agent) === 'public') {
    if (!isWorkspaceAdmin(member)) throw new Error('Solo un admin puede solicitar correcciones a un agente público.');
  } else if (agent.ownerMemberId !== callerUid || (issue.responsibleMemberId || issue.assigneeId) !== callerUid) {
    throw new Error('Solo el dueño puede solicitar correcciones a su agente personal en sus propios issues.');
  }
}

/** Rework checks out existing PR branches, rather than inventing branches in unrelated repos. */
export function reworkRepositories(issue: any, authorized: string[], target: string): string[] {
  const refs = issue.gitRefs?.length ? issue.gitRefs : issue.git ? [issue.git] : [];
  const active = refs.filter((ref: any) => ['open', 'draft'].includes(ref.prState) && Number.isInteger(ref.prNumber));
  if (!active.some((ref: any) => ref.repoFullName === target)) throw new Error('El repositorio destino debe tener un PR abierto para corregir.');
  if (active.some((ref: any) => !authorized.includes(ref.repoFullName) || !validBranch(ref.branch) || !ref.branch.startsWith('pul/'))) {
    throw new Error('Las ramas de los PRs deben estar registradas y autorizadas por el proyecto.');
  }
  return [...new Set<string>(active.map((ref: any) => ref.repoFullName))].sort();
}
