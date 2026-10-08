import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { listInstallationRepos } from './client';

/** Sync physical installation metadata and intersect each workspace's selection.
 * The transaction rereads bindings to serialize against selection changes. */
export async function refreshInstallationRepos(installationId: string): Promise<string[] | null> {
  const db = getFirestore();
  const ref = db.collection('github_installations').doc(String(installationId));
  const root = await ref.get();
  if (!root.exists || root.data()!.uninstalledAt || root.data()!.suspendedAt) return null;
  const repos = await listInstallationRepos(String(installationId));
  const available = repos.map(r => ({ id: r.id, fullName: r.full_name, defaultBranch: r.default_branch }));
  const names = available.map(r => r.fullName);
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    const bindings = await tx.get(db.collection('github_installations').where('installationId', '==', String(installationId)));
    if (!current.exists || current.data()!.uninstalledAt || current.data()!.suspendedAt) return;
    tx.update(ref, { availableRepositories: available, reposSyncedAt: new Date().toISOString() });
    for (const binding of bindings.docs.filter(d => d.data().workspaceId)) {
      const selected: string[] = binding.data().selectedRepositoryFullNames || binding.data().repositoryFullNames || [];
      const effective = selected.filter(r => names.includes(r));
      tx.update(binding.ref, {
        selectedRepositoryFullNames: selected, repositoryFullNames: effective,
        repositories: available.filter(r => effective.includes(r.fullName)), reposSyncedAt: new Date().toISOString(),
      });
    }
  });
  return names;
}

/** Revocation affects every binding; a webhook never grants a workspace access. */
export async function handleInstallationEvent(eventType: string, payload: any): Promise<void> {
  const id = payload?.installation?.id;
  if (!id) return;
  const db = getFirestore();
  const ref = db.collection('github_installations').doc(String(id));
  if (eventType === 'installation' && ['deleted', 'suspend', 'unsuspend', 'created'].includes(payload.action)) {
    await db.runTransaction(async tx => {
      const root = await tx.get(ref);
      const bindings = await tx.get(db.collection('github_installations').where('installationId', '==', String(id)));
      if (!root.exists) return;
      const revoked = payload.action === 'deleted' || payload.action === 'suspend';
      for (const doc of bindings.docs) {
        tx.update(doc.ref, revoked ? {
          ...(doc.data().workspaceId ? { selectedRepositoryFullNames: doc.data().selectedRepositoryFullNames || doc.data().repositoryFullNames || [] } : {}),
          repositories: [], repositoryFullNames: [], availableRepositories: [],
          [payload.action === 'deleted' ? 'uninstalledAt' : 'suspendedAt']: new Date().toISOString(),
          tokenCache: FieldValue.delete(),
        } : { suspendedAt: FieldValue.delete(), uninstalledAt: FieldValue.delete() });
      }
    });
    if (payload.action === 'deleted' || payload.action === 'suspend') return;
  }
  await refreshInstallationRepos(String(id));
}
