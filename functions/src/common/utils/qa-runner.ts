import { runnerPreflight } from './runner-preflight';

/**
 * Resolve a QA agent to its configured Runner, or to another Runner owned by
 * the same member that explicitly advertises this agent's QA identity. This
 * supports one local Runner serving separate dev/QA identities safely.
 */
export async function findProjectQaRunner(
  db: FirebaseFirestore.Firestore,
  agent: Record<string, any> & { id: string },
  workspaceId: string,
  repos: string[],
  now = Date.now(),
) {
  const snapshot = await db.collection('runners').where('workspaceId', '==', workspaceId).get();
  const runners: Array<Record<string, any> & { id: string }> = snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) => ({ ...doc.data(), id: doc.id }));
  const bound = runners.filter((runner: any) => runner.id === agent.runnerId);
  const shared = runners.filter((runner: any) =>
    runner.id !== agent.runnerId && !!agent.ownerMemberId && runner.ownerMemberId === agent.ownerMemberId,
  );
  const problems: string[] = [];

  for (const runner of [...bound, ...shared]) {
    const preflight = runnerPreflight(
      { ...agent, runnerId: runner.id },
      runner,
      workspaceId,
      repos,
      'review',
      now,
      true,
    );
    if (!preflight.ready) {
      problems.push(...preflight.problems.map((problem) => `${problem.message} ${problem.action}`));
      continue;
    }

    const jobs = await db.collection('runner_jobs').where('runnerId', '==', runner.id).get();
    const activeJobs = jobs.docs.filter((doc: FirebaseFirestore.QueryDocumentSnapshot) => {
      const job = doc.data();
      if (!['pending', 'delivered'].includes(job.status)) return false;
      const expiresAt = new Date(job.expiresAt).getTime();
      return !Number.isFinite(expiresAt) || expiresAt > now;
    }).length;
    if (activeJobs >= (runner.maxConcurrentJobs || 1)) {
      problems.push('El Pulse Runner QA ya alcanzó su límite de jobs activos. Esperá a que termine otro job y volvé a despachar.');
      continue;
    }

    return { runner, problems: [] as string[] };
  }

  return { runner: undefined, problems: Array.from(new Set(problems)) };
}
