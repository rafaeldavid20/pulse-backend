import { Firestore, FieldValue, Transaction } from 'firebase-admin/firestore';

/**
 * Atomically reserves the next sequential issue number for a given
 * workspace/team using a Firestore counter document, avoiding the race
 * condition of counting existing issues (two concurrent creates reading the
 * same count would mint duplicate identifiers).
 *
 * Counter doc id: `{workspaceId}_{teamId}` in the `counters` collection.
 * Issue numbering historically started at 101 (see the old
 * `qSnap.size + 101` logic this replaces), so a fresh counter starts there.
 *
 * If a `seedFn` is provided and the counter doesn't exist yet, it is used to
 * compute the starting value (e.g. `max(existing issue numbers) + 1`) instead
 * of defaulting to 101 — used for backfilling counters for teams that
 * already have issues created under the old non-atomic scheme.
 */
export async function nextIssueNumber(
  db: Firestore,
  workspaceId: string,
  teamId: string,
  seedFn?: () => Promise<number>
): Promise<number> {
  const counterRef = db.collection('counters').doc(`${workspaceId}_${teamId}`);

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(counterRef);

    if (!snap.exists) {
      const seed = seedFn ? await seedFn() : 101;
      tx.set(counterRef, {
        workspaceId,
        teamId,
        value: seed,
        updatedAt: new Date().toISOString(),
      });
      return seed;
    }

    const next = (snap.data()?.value ?? 100) + 1;
    tx.update(counterRef, {
      value: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });
    return next;
  });
}
