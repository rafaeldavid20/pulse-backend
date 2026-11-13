import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';

/** Notifications contain no job, profile, path or credential payloads. */
export async function signalRunner(db: Firestore, runnerId: string, topic: 'jobs' | 'profiles') {
  if (!runnerId) return;
  await db.collection('runner_signals').doc(runnerId).set({ [topic]: FieldValue.increment(1) }, { merge: true });
}
export async function signalIssue(db: Firestore, issueId: string) {
  if (issueId) await db.collection('issue_signals').doc(issueId).set({ revision: FieldValue.increment(1) }, { merge: true });
}
export async function signalProfile(db: Firestore, agentId: string) {
  if (agentId) await db.collection('profile_signals').doc(agentId).set({ revision: FieldValue.increment(1) }, { merge: true });
}

/** Session generation changes when the paired device credential changes. */
export async function runnerSubscriptionSession(db: Firestore, runnerId: string, credentialHash: string) {
  return db.runTransaction(async tx => {
    const ref = db.collection('runners').doc(runnerId);
    const runner = (await tx.get(ref)).data();
    if (!runner || runner.revokedAt || runner.deviceSecretHash !== credentialHash) throw new Error('Invalid runner credential');
    const session = runner.signalCredentialHash === credentialHash && runner.signalSessionId ? runner.signalSessionId : randomUUID();
    const signal = db.collection('runner_signals').doc(runnerId);
    const exists = (await tx.get(signal)).exists;
    if (runner.signalSessionId !== session) tx.update(ref, { signalSessionId: session, signalCredentialHash: credentialHash });
    if (!exists) tx.set(signal, { jobs: 0, profiles: 0 });
    return { runnerDevice: true, runnerId, workspaceId: runner.workspaceId as string, runnerSession: session as string };
  });
}
