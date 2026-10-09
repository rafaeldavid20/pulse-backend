export interface PublicationTarget {
  repo: string; branch: string; base: string; appId: string; installationId: string; slug: string; sha?: string;
}
export function publicationPayload(targets: PublicationTarget[] = []): string {
  return JSON.stringify([...targets].sort((a, b) => a.repo.localeCompare(b.repo)).map(t => [t.repo, t.branch, t.base, t.appId, t.installationId, t.slug, t.sha || '']));
}
export function validBranch(value: any): boolean {
  return typeof value === 'string' && value.length <= 200 && !/\.\.|@\{|[\s~^:?*\[\\]|\/\/|\.$|\.lock(?:\/|$)|^\/|\/$/.test(value) && value.split('/').every((p: string) => p && !p.startsWith('.'));
}
/** Allow-list only: untrusted reports never store paths, output or credentials. */
export function parsePublication(value: any, job: any) {
  if (value === undefined) return null;
  if (job.protocolVersion !== 3 || !value || !['completed', 'failed'].includes(value.execution) || !Array.isArray(value.repositories) || value.repositories.length > 100) throw new Error('Invalid publication report.');
  const seen = new Set<string>();
  const repositories = value.repositories.map((entry: any) => {
    const target = job.publicationTargets?.find((t: any) => t.repo === entry.repo);
    if (!target || seen.has(entry.repo) || entry.branch !== target.branch || !/^[a-f0-9]{40}$/.test(entry.sha) || (target.sha && target.sha !== entry.sha) || !['pending', 'pushed', 'pr_created', 'linked'].includes(entry.stage)) throw new Error('Invalid publication repository.');
    seen.add(entry.repo);
    const prNumber = entry.prNumber;
    const prUrl = prNumber ? `https://github.com/${entry.repo}/pull/${prNumber}` : undefined;
    if (['pr_created', 'linked'].includes(entry.stage) && (!Number.isSafeInteger(prNumber) || prNumber < 1 || entry.prUrl !== prUrl)) throw new Error('Invalid publication PR.');
    return { repo: entry.repo, branch: entry.branch, sha: entry.sha, stage: entry.stage, ...(prUrl ? { prNumber, prUrl } : {}) };
  });
  return { execution: value.execution as 'completed' | 'failed', repositories };
}
