/** Stable PR identity for dispatch revalidation; source preflight resolves live heads at claim. */
export function reviewRequestRefs(issue: Record<string, any>): string {
  if ((issue.pendingRepoWork || []).length) throw new Error('Esperá a que termine el trabajo pendiente en otros repos antes de solicitar QA.');
  const refs = issue.gitRefs?.length ? issue.gitRefs : issue.git ? [issue.git] : [];
  if (!refs.length || refs.some((r: any) => !r.repoFullName || !r.prNumber || !['open', 'merged'].includes(r.prState)) || refs.every((r: any) => r.prState === 'merged')) {
    throw new Error('QA requiere PRs abiertos o mergeados y al menos uno abierto. Revisá los PRs vinculados.');
  }
  return JSON.stringify(refs.map((r: any) => [r.repoFullName, r.prNumber, r.branch || '', r.prState]).sort());
}

export function assertReviewRequest(issue: Record<string, any> | undefined, attempt: number, refs: string, manual: boolean, maxAttempts: number) {
  if (!issue || !['in_review', 'in_progress', 'todo'].includes(issue.status) || (!manual && issue.status !== 'in_review')) throw new Error('La issue ya no está disponible para revisión.');
  if ((issue.review?.attempt || 0) !== attempt || issue.review?.state === 'running') throw new Error('La revisión cambió o sigue activa. Esperá a que termine y reintentá.');
  if (reviewRequestRefs(issue) !== refs) throw new Error('Los PRs vinculados cambiaron. Volvé a solicitar QA.');
  if (!manual && (attempt >= maxAttempts || issue.review?.state === 'needs_human')) throw new Error('Se agotó la revisión automática. Solicitá una revisión manual desde la issue.');
}
