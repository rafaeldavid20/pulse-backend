import { Firestore } from 'firebase-admin/firestore';

/** Terminal history must never occupy the bounded pending-job page. */
export async function findPendingRunnerJob(db: Firestore, runnerId: string, now = Date.now()) {
  const query = db.collection('runner_jobs').where('runnerId', '==', runnerId).where('status', '==', 'pending').limit(20);
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  let oldest: FirebaseFirestore.DocumentData | null = null;
  for (;;) {
    const page = await (cursor ? query.startAfter(cursor) : query).get();
    for (const doc of page.docs) {
      const job = doc.data();
      if (job.runnerId !== runnerId || job.status !== 'pending' || !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= now || typeof job.issuedAt !== 'string') continue;
      if (!oldest || job.issuedAt.localeCompare(oldest.issuedAt) < 0) oldest = job;
    }
    if (page.size < 20) return oldest;
    cursor = page.docs[page.docs.length - 1];
  }
}
