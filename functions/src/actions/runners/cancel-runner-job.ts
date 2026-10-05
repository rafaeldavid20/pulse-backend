import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { ReportReviewIncompleteAction } from '../reviews/report-review-incomplete';
import { isWorkspaceAdmin } from '../../common/utils/agent-authorization';

/** Keeps delivered jobs active until their Runner acknowledges local cleanup. */
export class CancelRunnerJobAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.cancelJob', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const jobId = this.action.data.jobId;
    if (typeof jobId !== 'string' || !jobId) throw new Error('jobId es obligatorio.');
    const db = getFirestore();
    const jobRef = db.collection('runner_jobs').doc(jobId);
    const now = new Date().toISOString();
    const result = await db.runTransaction(async (transaction) => {
      const jobSnap = await transaction.get(jobRef);
      if (!jobSnap.exists) throw new Error('El job no existe.');
      const job = jobSnap.data()!;
      const [runnerSnap, callerSnap, runSnap, keys] = await Promise.all([
        transaction.get(db.collection('runners').doc(job.runnerId)),
        transaction.get(db.collection('members').doc(`${job.workspaceId}_${this.caller.uid}`)),
        transaction.get(db.collection('agent_runs').doc(jobId)),
        transaction.get(db.collection('api_keys').where('jobId', '==', jobId)),
      ]);
      const runner = runnerSnap.data();
      if (!callerSnap.exists || !runner || runner.workspaceId !== job.workspaceId ||
          (runner.ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(callerSnap.data()!))) {
        throw new Error('Sólo el dueño del Runner o un admin del workspace puede cancelar este job.');
      }
      if (!['pending', 'delivered'].includes(job.status)) return { jobId, status: job.status, cancelRequested: false, alreadyCompleted: true };
      if (job.cancelRequestedAt) return { jobId, status: job.status, cancelRequested: true };
      const pending = job.status === 'pending';
      transaction.update(jobRef, {
        cancelRequestedAt: now, cancelRequestedBy: this.caller.uid,
        ...(pending ? { status: 'canceled', completedAt: now, result: 'Cancelado antes de la entrega.' } : {}),
      });
      if (pending && runSnap.exists && runSnap.data()!.workspaceId === job.workspaceId) {
        transaction.update(runSnap.ref, { runnerOutcome: 'canceled', usage: null });
      }
      // Cut off MCP immediately; the local process still needs to be stopped.
      for (const key of keys.docs) transaction.update(key.ref, { revokedAt: now });
      return { jobId, status: pending ? 'canceled' : 'delivered', cancelRequested: true };
    });
    // A canceled queued QA job will never reach pulseRunnerComplete. Reuse
    // the same incomplete-review path as a delivered canceled QA job.
    if (result.status === 'canceled' && !('alreadyCompleted' in result)) {
      const job = (await jobRef.get()).data()!;
      if (job.mode === 'review') {
        await new ReportReviewIncompleteAction({ actionCode: 'reviews.reportIncomplete', data: {
          issueId: job.issueId, reason: 'El job de revisión fue cancelado antes de la entrega.',
        } }, job.agentId).run();
      }
    }
    return result;
  }
}

