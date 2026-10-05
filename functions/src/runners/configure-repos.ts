import { Firestore } from 'firebase-admin/firestore';

export async function configureRunnerRepos(db: Firestore, runnerId: string, repos: unknown): Promise<string[]> {
  if (!Array.isArray(repos) || repos.some((repo) => typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw Object.assign(new Error('Invalid repositories.'), { status: 400 });
  const connectedRepos: string[] = [...new Set(repos)];
  await db.runTransaction(async (transaction) => {
    const ref = db.collection('runners').doc(runnerId);
    const current = await transaction.get(ref);
    if (!current.exists || current.data()!.revokedAt) throw Object.assign(new Error('Runner unavailable.'), { status: 401 });
    const approved: string[] = current.data()!.connectedRepos || [];
    if (connectedRepos.some((repo) => !approved.includes(repo))) throw Object.assign(new Error('Repository expansion requires owner/admin approval in Pulse.'), { status: 403 });
    transaction.update(ref, { connectedRepos, updatedAt: new Date().toISOString() });
  });
  return connectedRepos;
}
