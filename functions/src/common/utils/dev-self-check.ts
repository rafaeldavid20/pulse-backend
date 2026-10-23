/** True only when this delivery has current, complete evidence for its rubric. */
export type DevSelfCheckHead = { repo: string; headSha: string };

export function hasCompleteDevSelfCheck(issue: any, project: any, jobId?: string, deliveredAt?: string, expectedHeads?: DevSelfCheckHead[]): boolean {
  const required = [
    ...(issue?.acceptanceCriteria || []).map((criterion: any) => criterion?.id),
    ...(project?.definitionOfDone || []).map((criterion: any) => criterion?.id),
  ];
  if (!required.length || required.some((id: unknown) => typeof id !== 'string' || !id.trim())) return false;
  const delivered = Date.parse(deliveredAt || '');
  const checked = Date.parse(issue?.devSelfCheckAt || '');
  if (!Number.isFinite(delivered) || !Number.isFinite(checked) || checked < delivered) return false;
  if (jobId && issue?.devSelfCheckJobId !== jobId) return false;
  if (expectedHeads) {
    const actual = Array.isArray(issue?.devSelfCheckHeadScope) ? issue.devSelfCheckHeadScope : [];
    if (!expectedHeads.length
      || expectedHeads.some(({repo, headSha}) => typeof repo !== 'string' || !/^[a-f0-9]{40}$/.test(headSha))
      || actual.some((head: any) => typeof head?.repo !== 'string' || !/^[a-f0-9]{40}$/.test(head?.headSha || ''))
      || expectedHeads.some(({repo, headSha}) => !actual.some((head: DevSelfCheckHead) => head.repo === repo && head.headSha === headSha))) return false;
  }
  const checks = Array.isArray(issue?.devSelfCheck) ? issue.devSelfCheck : [];
  const byId = new Map(checks.map((check: any) => [check?.criterionId, check]));
  return required.every((id: string) => {
    const check: any = byId.get(id);
    return check?.result === 'met' && typeof check.evidence === 'string' && !!check.evidence.trim();
  });
}
