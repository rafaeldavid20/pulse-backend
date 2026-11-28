/** Stable PR identity for dispatch revalidation; source preflight resolves live heads at claim. */
export function reviewRequestRefs(issue: Record<string, any>, allowDraft = false): string {
  if ((issue.pendingRepoWork || []).length) throw new Error('Esperá a que termine el trabajo pendiente en otros repos antes de solicitar QA.');
  const refs = issue.gitRefs?.length ? issue.gitRefs : issue.git ? [issue.git] : [];
  const allowed = allowDraft ? ['open', 'draft', 'merged'] : ['open', 'merged'];
  if (!refs.length || refs.some((r: any) => !r.repoFullName || !r.prNumber || !allowed.includes(r.prState)) || refs.every((r: any) => r.prState === 'merged')) {
    throw new Error('QA requiere PRs abiertos o mergeados y al menos uno abierto. Revisá los PRs vinculados.');
  }
  return JSON.stringify(refs.map((r: any) => [r.repoFullName, r.prNumber, r.branch || '', r.prState]).sort());
}

export function assertReviewRequest(issue: Record<string, any> | undefined, attempt: number, refs: string, manual: boolean, maxAttempts: number) {
  if (!issue || !['in_review', 'in_progress', 'todo'].includes(issue.status) || (!manual && issue.status !== 'in_review')) throw new Error('La issue ya no está disponible para revisión.');
  if ((issue.review?.attempt || 0) !== attempt || issue.review?.state === 'running') throw new Error('La revisión cambió o sigue activa. Esperá a que termine y reintentá.');
  if (reviewRequestRefs(issue, manual) !== refs) throw new Error('Los PRs vinculados cambiaron. Volvé a solicitar QA.');
  if (!manual && (attempt >= maxAttempts || issue.review?.state === 'needs_human')) throw new Error('Se agotó la revisión automática. Solicitá una revisión manual desde la issue.');
}
/** An approval applies only to the complete recorded set of PR heads. */
export function hasCurrentApproval(issue: Record<string, any>): boolean {
  if (issue.review?.state !== 'approved') return false;
  const refs = issue.gitRefs?.length ? issue.gitRefs : issue.git ? [issue.git] : [];
  const reviewed = Array.isArray(issue.review.prs) ? issue.review.prs : [];
  const key = (r: any) => `${r.repoFullName}#${r.prNumber}`;
  return refs.length > 0 && refs.length === reviewed.length &&
    new Set(refs.map(key)).size === refs.length && new Set(reviewed.map(key)).size === reviewed.length &&
    refs.every((r: any) => r.repoFullName && r.prNumber && /^[a-f0-9]{40}$/.test(r.headSha || '') &&
      reviewed.some((p: any) => p.repoFullName === r.repoFullName && p.prNumber === r.prNumber && p.headSha === r.headSha));
}

/** Invalidate approval atomically with a change to its recorded PR scope. */
export function invalidateChangedApproval(issue: Record<string, any>, refs: any[], now: string): Record<string, unknown> {
  return issue.review?.state === 'approved' && !hasCurrentApproval({ ...issue, gitRefs: refs })
    ? { 'review.state': 'stale', reviewScopeInvalidatedAt: now } : {};
}
