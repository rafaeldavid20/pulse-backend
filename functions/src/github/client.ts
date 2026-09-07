import { getInstallationToken, signAppJwt } from './app-auth';

const API_BASE = 'https://api.github.com';

async function githubApiFetch(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${init?.method || 'GET'} ${path} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Authenticates as the App itself (not an installation) — used to look up installation metadata. */
async function githubAppFetch(path: string, init?: RequestInit) {
  return githubApiFetch(path, signAppJwt(), init);
}

/** Authenticates as an installation — used for everything that touches repo contents. */
async function githubInstallationFetch(installationId: string, path: string, init?: RequestInit) {
  const token = await getInstallationToken(installationId);
  return githubApiFetch(path, token, init);
}

export interface InstallationInfo {
  id: number;
  account: { login: string; type: string };
}

export async function getInstallation(installationId: string): Promise<InstallationInfo> {
  return githubAppFetch(`/app/installations/${installationId}`) as Promise<InstallationInfo>;
}

export interface InstallationRepo {
  id: number;
  full_name: string;
  default_branch: string;
}

export async function listInstallationRepos(installationId: string): Promise<InstallationRepo[]> {
  const body = (await githubInstallationFetch(installationId, '/installation/repositories')) as {
    repositories: InstallationRepo[];
  };
  return body.repositories;
}

async function getRepo(installationId: string, repoFullName: string): Promise<InstallationRepo> {
  return githubInstallationFetch(installationId, `/repos/${repoFullName}`) as Promise<InstallationRepo>;
}

async function getRefSha(installationId: string, repoFullName: string, branch: string): Promise<string> {
  const body = (await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/git/ref/heads/${branch}`
  )) as { object: { sha: string } };
  return body.object.sha;
}

export interface CreatedBranch {
  repoFullName: string;
  branch: string;
  baseBranch: string;
  branchUrl: string;
}

/** Creates `branch` off the repo's default branch (or `baseBranch` if given). */
export async function createBranch(
  installationId: string,
  repoFullName: string,
  branch: string,
  baseBranch?: string
): Promise<CreatedBranch> {
  const repo = baseBranch ? null : await getRepo(installationId, repoFullName);
  const base = baseBranch || repo!.default_branch;
  const baseSha = await getRefSha(installationId, repoFullName, base);

  await githubInstallationFetch(installationId, `/repos/${repoFullName}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  return {
    repoFullName,
    branch,
    baseBranch: base,
    branchUrl: `https://github.com/${repoFullName}/tree/${encodeURIComponent(branch)}`,
  };
}
