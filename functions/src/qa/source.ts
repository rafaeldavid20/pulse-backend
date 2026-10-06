import { signAppJwt } from '../github/app-auth';

export interface QaRepo { repo: string; sha: string; prNumber?: number }
export const QA_SOURCE_CREDENTIAL_HEADER = 'x-pulse-qa-credential';
export function qaSourceAuthorization(credential: unknown, legacyAuthorization?: string): string | undefined {
  return typeof credential === 'string' && credential.trim()
    ? `Bearer ${credential.trim()}`
    : legacyAuthorization;
}
const validRepo = (repo: string) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
export function qaProjectRepos(project: any, workspaceId: string, refs: any[]): string[] {
  if (!project || project.workspaceId !== workspaceId || !Array.isArray(project.repoFullNames) || !project.repoFullNames.length) throw new Error('Configurá repositorios en el proyecto de este workspace.');
  const repos: string[] = [...new Set<string>(project.repoFullNames)];
  if (repos.some((repo) => !validRepo(repo)) || refs.some((ref) => !repos.includes(ref.repoFullName))) throw new Error('Los PRs deben pertenecer a los repositorios actuales del proyecto.');
  return repos;
}

/** Fresh, repository-scoped read-only identity. Never cache, persist or return it. */
export async function withQaRepo<T>(installationId: string, repo: string, work: (get: (path: string) => Promise<Response>) => Promise<T>, fetcher: typeof fetch = fetch, jwt: () => string = signAppJwt): Promise<T> {
  const minted = await fetcher(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${jwt()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [repo.split('/')[1]], permissions: { contents: 'read', pull_requests: 'read' } }),
  });
  if (!minted.ok) throw new Error(`${repo}: identidad GitHub de lectura no disponible (HTTP ${minted.status}).`);
  const { token } = await minted.json() as { token: string };
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  try {
    return await work(async (path) => {
      const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, { headers, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`${repo}: lectura GitHub no disponible (HTTP ${response.status}).`);
      return response;
    });
  } finally {
    await fetcher('https://api.github.com/installation/token', { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
}

export async function resolveQaRepo(repo: string, ref: any, get: (path: string) => Promise<Response>): Promise<QaRepo> {
  const metadata = await (await get('')).json() as any;
  if (metadata.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error(`${repo}: metadatos no coinciden.`);
  let sha: string;
  if (ref?.prNumber) {
    const pr = await (await get(`pulls/${ref.prNumber}`)).json() as any;
    if (pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase() || pr.head.repo?.full_name.toLowerCase() !== repo.toLowerCase() || pr.head.ref !== ref.branch) throw new Error(`${repo}: origen del PR no autorizado.`);
    sha = pr.head.sha;
  } else {
    sha = ((await (await get(`commits/${encodeURIComponent(metadata.default_branch)}`)).json()) as any).sha;
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`${repo}: head inválido.`);
  // Contents + archive access are separate from metadata/PR access.
  await get(`git/trees/${sha}`);
  return { repo, sha, ...(ref?.prNumber ? { prNumber: ref.prNumber } : {}) };
}

export async function qaArchive(get: (path: string) => Promise<Response>, sha: string): Promise<Buffer> {
  const response = await get(`zipball/${sha}`);
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new Error('Archivo GitHub vacío.');
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > 30 * 1024 * 1024) throw new Error('Snapshot supera el límite de 30 MiB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function assertQaPrepared(proof: any, project: any, workspaceId: string, refs: any[], now = Date.now()) {
  const repos = qaProjectRepos(project, workspaceId, refs);
  if (!proof || proof.workspaceId !== workspaceId || !Number.isFinite(Date.parse(proof.checkedAt)) || now - Date.parse(proof.checkedAt) > 10 * 60_000 || Date.parse(proof.checkedAt) > now || proof.repositories.length !== repos.length || repos.some((repo) => !proof.repositories.some((entry: QaRepo) => entry.repo === repo && proof.downloaded?.[repo] === entry.sha)) || refs.some((ref) => !proof.repositories.some((entry: QaRepo) => entry.repo === ref.repoFullName && entry.prNumber === ref.prNumber))) {
    throw new Error('QA infraestructura: falta un preflight reciente y snapshots completos de todos los repos actuales del proyecto.');
  }
  return proof.repositories as QaRepo[];
}

export function assertQaReviewedHeads(reviewed: Array<{ repoFullName: string; prNumber: number; headSha: string }> | undefined, prs: Array<{ repoFullName: string; prNumber: number }>, current: Array<{ repoFullName: string; prNumber: number; headSha: string }>) {
  if (!reviewed?.length || prs.some((pr) => !reviewed.some((entry) => entry.repoFullName === pr.repoFullName && entry.prNumber === pr.prNumber && current.some((head) => head.repoFullName === entry.repoFullName && head.prNumber === entry.prNumber && head.headSha === entry.headSha)))) {
    throw new Error('QA infraestructura: el head cambió o perdió acceso desde el snapshot; repetí el preflight y la revisión.');
  }
}
