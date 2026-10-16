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

/** Only a recorded human return may resume the archived findings at attempt zero.
 * Older returnToAgent calls left this pending state without enqueuing a job.
 */
export function returnedDevelopmentReview(issue: any): any | undefined {
  const review = issue?.review;
  const archived = review?.history?.[review.history.length - 1];
  if (!['pending', 'changes_requested'].includes(review?.state) || review.attempt !== 0 || archived?.state !== 'needs_human' ||
      typeof issue.runBudgetResetBy !== 'string' || !issue.runBudgetResetBy ||
      !Number.isFinite(Date.parse(issue.runBudgetResetAt))) return undefined;
  if (review.state === 'changes_requested') return review;
  return { state: 'changes_requested', attempt: 0, history: review.history,
    reviewerId: archived.reviewerId || archived.dispatchedTo, findings: archived.findings,
    verdict: archived.verdict, criteriaResults: archived.criteriaResults, prs: archived.prs };
}
