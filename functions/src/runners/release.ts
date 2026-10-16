import { getFirestore } from 'firebase-admin/firestore';
import { createRunnerReleaseLookup, RunnerRelease } from '../common/utils/runner-version';

/** Public package metadata only; never scoped Runner or workspace data. Admin SDK only. */
export const getRunnerRelease = createRunnerReleaseLookup({
  async claim(now) {
    const db = getFirestore();
    const ref = db.collection('public_package_cache').doc('pulse-runner-latest');
    return db.runTransaction(async tx => {
      const cached = (await tx.get(ref)).data();
      if (cached?.release?.nextCheckAt > now || cached?.leaseUntil > now) {
        return { claimed: false, release: cached?.release as RunnerRelease | undefined };
      }
      tx.set(ref, { leaseUntil: now + 10_000 }, { merge: true });
      return { claimed: true };
    });
  },
  async save(release) {
    await getFirestore().collection('public_package_cache').doc('pulse-runner-latest').set({ release, leaseUntil: 0 });
  },
});
