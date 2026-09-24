import { getFirestore } from 'firebase-admin/firestore';
import { listInstallationRepos } from './client';

/**
 * Mantiene al día la lista de repos de `github_installations/{installationId}`
 * (TES-278). Antes se escribía una sola vez, en `githubSetup`, y nada la
 * actualizaba: darle acceso a la App a un repo nuevo desde GitHub no llegaba a
 * Pulse, y el repo no aparecía para elegir ni se podía atar.
 *
 * Sólo actualiza un doc que ya existe: qué workspace es dueño de una
 * instalación lo decide `githubSetup` (con el `state` firmado), nunca un
 * webhook.
 */
export async function refreshInstallationRepos(installationId: string): Promise<string[] | null> {
  const ref = getFirestore().collection('github_installations').doc(String(installationId));
  const snap = await ref.get();
  if (!snap.exists) return null;

  const repos = await listInstallationRepos(String(installationId));
  const repositoryFullNames = repos.map((r) => r.full_name);
  // `github.status` llama esto en cada apertura de Settings: sin cambios, no se escribe.
  const current: string[] = snap.data()!.repositoryFullNames || [];
  if (current.length === repositoryFullNames.length && current.every((r) => repositoryFullNames.includes(r))) {
    return repositoryFullNames;
  }
  await ref.update({
    repositories: repos.map((r) => ({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch })),
    repositoryFullNames,
    reposSyncedAt: new Date().toISOString(),
  });
  return repositoryFullNames;
}

/**
 * Eventos de la instalación que llegan al webhook. `installation_repositories`
 * (repos agregados o quitados) y `installation` con `created`,
 * `new_permissions_accepted` o `unsuspend` refrescan los repos. `deleted` y
 * `suspend` dejan la instalación sin repos: la App ya no puede tocar ninguno,
 * y mostrarlos como disponibles sería mentir.
 */
export async function handleInstallationEvent(eventType: string, payload: any): Promise<void> {
  const installationId = payload?.installation?.id;
  if (!installationId) return;

  if (eventType === 'installation' && (payload.action === 'deleted' || payload.action === 'suspend')) {
    const ref = getFirestore().collection('github_installations').doc(String(installationId));
    if (!(await ref.get()).exists) return;
    await ref.update({
      repositories: [],
      repositoryFullNames: [],
      [payload.action === 'deleted' ? 'uninstalledAt' : 'suspendedAt']: new Date().toISOString(),
      reposSyncedAt: new Date().toISOString(),
    });
    return;
  }

  await refreshInstallationRepos(String(installationId));
}
