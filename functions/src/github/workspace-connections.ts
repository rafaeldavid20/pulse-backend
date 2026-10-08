import { getFirestore, FieldValue } from 'firebase-admin/firestore';

export function isAdmin(member: any): boolean {
  return member?.role === 'owner' || member?.role === 'admin';
}

/** Existing workspace queries continue to read scoped connection documents.
 * Only the canonical installation document holds the token cache. */
export async function saveWorkspaceConnection(
  workspaceId: string, uid: string, installationId: string, selected: string[],
): Promise<void> {
  const db = getFirestore();
  await db.runTransaction(async (tx) => {
    const root = await tx.get(db.collection('github_installations').doc(installationId));
    const connections = await tx.get(db.collection('github_installations').where('installationId', '==', installationId));
    const current = await tx.get(db.collection('github_installations').where('workspaceId', '==', workspaceId));
    const targetMember = await tx.get(db.collection('members').doc(`${workspaceId}_${uid}`));
    const members = await Promise.all(connections.docs.filter(d => d.data().workspaceId).map(d =>
      tx.get(db.collection('members').doc(`${d.data().workspaceId}_${uid}`))));
    const agents = await tx.get(db.collection('agents').where('workspaceId', '==', workspaceId));
    const environments = await tx.get(db.collection('environments').where('workspaceId', '==', workspaceId));
    if (!isAdmin(targetMember.data()) || !members.some(m => isAdmin(m.data()))) {
      throw new Error('Se requiere ser admin de este workspace y de uno que ya tenga esta cuenta conectada.');
    }
    if (!root.exists || root.data()!.suspendedAt || root.data()!.uninstalledAt) {
      throw new Error('La instalación de GitHub no está disponible.');
    }
    if (current.docs.some(d => String(d.data().installationId) !== installationId && !d.data().uninstalledAt)) {
      throw new Error('Este workspace ya está conectado a otra cuenta de GitHub.');
    }
    const available = root.data()!.availableRepositories || root.data()!.repositories || [];
    const names: string[] = available.map((r: any) => r.fullName);
    if (selected.some(r => !names.includes(r))) throw new Error('Hay repositorios sin acceso autorizado en GitHub. Actualizá la lista.');
    const others = connections.docs.filter(d => d.data().workspaceId && d.data().workspaceId !== workspaceId);
    if (others.some(d => selected.some(r => (d.data().selectedRepositoryFullNames || d.data().repositoryFullNames || []).includes(r)))) {
      throw new Error('Un repositorio elegido ya pertenece a otro workspace. Quitalo allí primero.');
    }
    const previous = current.docs[0];
    const removed = (previous?.data().selectedRepositoryFullNames || previous?.data().repositoryFullNames || []).filter((r: string) => !selected.includes(r));
    if ([...agents.docs, ...environments.docs].some(d => (d.data().connectedRepos || []).some((r: any) => removed.includes(r.repoFullName)))) {
      throw new Error('Desconectá primero los agentes y entornos de los repositorios que querés quitar.');
    }
    // Freeze legacy ownership before creating a second binding. New GitHub
    // grants must never silently widen an existing workspace's access.
    for (const other of others) {
      if (!Array.isArray(other.data().selectedRepositoryFullNames)) {
        tx.update(other.ref, { selectedRepositoryFullNames: other.data().repositoryFullNames || [] });
      }
    }
    const replacing = previous && String(previous.data().installationId) !== installationId;
    if (replacing) for (const old of current.docs) tx.update(old.ref, { workspaceId: FieldValue.delete() });
    const ref = (!replacing && previous?.ref) || db.collection('github_installations').doc(`${installationId}_${workspaceId}`);
    tx.set(ref, {
      installationId, workspaceId, accountLogin: root.data()!.accountLogin,
      selectedRepositoryFullNames: [...new Set(selected)],
      repositories: available.filter((r: any) => selected.includes(r.fullName)),
      repositoryFullNames: [...new Set(selected)], connectedBy: uid,
      connectedAt: previous?.data().connectedAt || new Date().toISOString(),
      reposSyncedAt: new Date().toISOString(), suspendedAt: FieldValue.delete(), uninstalledAt: FieldValue.delete(),
    }, { merge: true });
  });
}

/** Only admins can discover installations reusable through their own memberships. */
export async function reusableConnections(workspaceId: string, uid: string) {
  const db = getFirestore();
  if (!isAdmin((await db.collection('members').doc(`${workspaceId}_${uid}`).get()).data())) return [];
  const memberships = await db.collection('members').where('userId', '==', uid).get();
  const ids = new Set<string>();
  for (const member of memberships.docs.filter(m => isAdmin(m.data()))) {
    const connections = await db.collection('github_installations').where('workspaceId', '==', member.data().workspaceId).get();
    for (const connection of connections.docs) ids.add(String(connection.data().installationId));
  }
  const result = [];
  for (const id of ids) {
    const root = await db.collection('github_installations').doc(id).get();
    if (!root.exists || root.data()!.suspendedAt || root.data()!.uninstalledAt) continue;
    const bindings = await db.collection('github_installations').where('installationId', '==', id).get();
    const assignedElsewhere = bindings.docs.filter(d => d.data().workspaceId && d.data().workspaceId !== workspaceId)
      .flatMap(d => d.data().selectedRepositoryFullNames || d.data().repositoryFullNames || []);
    result.push({ installationId: id, accountLogin: root.data()!.accountLogin,
      repositories: (root.data()!.availableRepositories || root.data()!.repositories || []).map((r: any) => r.fullName),
      assignedElsewhere: [...new Set(assignedElsewhere)],
    });
  }
  return result;
}
