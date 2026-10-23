/** True only when this delivery has current, complete evidence for its rubric. */
export function hasCompleteDevSelfCheck(issue: any, project: any, jobId?: string, deliveredAt?: string): boolean {
  const required = [
    ...(issue?.acceptanceCriteria || []).map((criterion: any) => criterion?.id),
    ...(project?.definitionOfDone || []).map((criterion: any) => criterion?.id),
  ];
  if (!required.length || required.some((id: unknown) => typeof id !== 'string' || !id.trim())) return false;
  const delivered = Date.parse(deliveredAt || '');
  const checked = Date.parse(issue?.devSelfCheckAt || '');
  if (!Number.isFinite(delivered) || !Number.isFinite(checked) || checked < delivered) return false;
  if (jobId && issue?.devSelfCheckJobId !== jobId) return false;
  const checks = Array.isArray(issue?.devSelfCheck) ? issue.devSelfCheck : [];
  const byId = new Map(checks.map((check: any) => [check?.criterionId, check]));
  return required.every((id: string) => {
    const check: any = byId.get(id);
    return check?.result === 'met' && typeof check.evidence === 'string' && !!check.evidence.trim();
  });
}
