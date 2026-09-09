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
  /** Mapa permiso -> 'read' | 'write'. Es la respuesta autoritativa sobre qué
   *  puede hacer la App en esta instalación, sin tener que probar endpoints. */
  permissions?: Record<string, string>;
}

/** Permisos que `agents.connectRepo` necesita para provisionar un repo. */
export const REQUIRED_CONNECT_PERMISSIONS = ['secrets', 'workflows', 'contents'] as const;

/**
 * Qué permisos de los necesarios le faltan a la instalación.
 *
 * Se consulta en vez de probarse contra un endpoint real porque un 403 en
 * mitad de `connectRepo` deja el trabajo a medias (key creada, secret no
 * escrito). Saberlo antes permite que la UI pida reinstalar y no empiece nada.
 */
export async function missingConnectPermissions(installationId: string): Promise<string[]> {
  const info = await getInstallation(installationId);
  const granted = info.permissions || {};
  return REQUIRED_CONNECT_PERMISSIONS.filter((p) => granted[p] !== 'write');
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

/** Fires a `repository_dispatch` event — how the Fase 6 Firestore trigger
 * kicks off `.github/workflows/pulse-agent.yml` without a human involved. */
export async function dispatchRepositoryEvent(
  installationId: string,
  repoFullName: string,
  eventType: string,
  clientPayload: Record<string, unknown>
): Promise<void> {
  await githubInstallationFetch(installationId, `/repos/${repoFullName}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
}

// ---------------------------------------------------------------------------
// Provisioning de repos conectados (agents.connectRepo / disconnectRepo)
// ---------------------------------------------------------------------------

/**
 * Escribe un secret de Actions en un repo.
 *
 * GitHub no acepta el valor en claro: hay que encriptarlo con la clave pública
 * del repo usando un sealed box de libsodium (X25519 + XSalsa20-Poly1305). El
 * `crypto` nativo de Node no implementa esa construcción, de ahí la dependencia
 * de `libsodium-wrappers`.
 *
 * El valor nunca se loguea ni se devuelve: entra, se encripta, se manda.
 */
export async function setRepoSecret(
  installationId: string,
  repoFullName: string,
  secretName: string,
  secretValue: string
): Promise<void> {
  const key = await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/actions/secrets/public-key`
  );

  const sodium = (await import('libsodium-wrappers')).default;
  await sodium.ready;

  const encrypted = sodium.crypto_box_seal(
    sodium.from_string(secretValue),
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)
  );

  await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/actions/secrets/${secretName}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
        key_id: key.key_id,
      }),
    }
  );
}

export async function deleteRepoSecret(
  installationId: string,
  repoFullName: string,
  secretName: string
): Promise<void> {
  await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/actions/secrets/${secretName}`,
    { method: 'DELETE' }
  );
}

/**
 * Nombres de los secrets de Actions de un repo. GitHub nunca devuelve los
 * valores, solo los nombres — que es justo lo que hace falta para poder mostrar
 * "el token de Anthropic ya está puesto" sin que Pulse lo vea nunca.
 */
export async function listRepoSecretNames(
  installationId: string,
  repoFullName: string
): Promise<string[]> {
  const res = await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/actions/secrets?per_page=100`
  );
  return (res.secrets || []).map((s: { name: string }) => s.name);
}

/**
 * Crea o actualiza un archivo en la rama por defecto del repo.
 *
 * La Contents API exige el `sha` del blob actual para sobrescribir, así que
 * primero se consulta si el archivo existe. Un 404 ahí es el caso normal
 * (primera conexión), no un error.
 */
export async function putRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  content: string,
  message: string
): Promise<{ sha: string; created: boolean }> {
  let existingSha: string | undefined;
  try {
    const current = await githubInstallationFetch(
      installationId,
      `/repos/${repoFullName}/contents/${path}`
    );
    existingSha = current.sha;
  } catch {
    // No existe todavía: es una creación.
  }

  const res = await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/contents/${path}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    }
  );

  return { sha: res.content.sha, created: !existingSha };
}

export async function deleteRepoFile(
  installationId: string,
  repoFullName: string,
  path: string,
  message: string
): Promise<void> {
  const current = await githubInstallationFetch(
    installationId,
    `/repos/${repoFullName}/contents/${path}`
  );
  await githubInstallationFetch(installationId, `/repos/${repoFullName}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha: current.sha }),
  });
}
