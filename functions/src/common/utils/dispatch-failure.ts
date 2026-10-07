import { Firestore } from 'firebase-admin/firestore';
import { IssueAgentState } from '../domain.generated';

type Failure = NonNullable<IssueAgentState['dispatchFailure']>;
// Un run tarda ~30s en arrancar y reclamar el issue (ver `agent.state ===
// 'claimed'` en claim-issue.ts), así que ese guard solo no alcanza para
// separar dos dispatches que ocurren antes de que cualquiera llegue a
// reclamar (TES-130: dos dispatches en 4s, mismo issue, mismo agente, dos
// runs en paralelo). Esta ventana cubre ese hueco.
export const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

/** Only trusted, fixed diagnostics belong in an issue; never exception text. */
export class RunnerDispatchError extends Error {
  constructor(public stage: Failure['stage'], public reasons: string[], public silent = false) {
    super(reasons.join(' '));
  }
}

export async function reportDispatchFailure(db: Firestore, issueId: string, agentId: string, startedAt: string, error: unknown) {
  if (error instanceof RunnerDispatchError && error.silent) return;
  const failure: Failure = {
    stage: error instanceof RunnerDispatchError ? error.stage : 'enqueue',
    reasons: error instanceof RunnerDispatchError ? error.reasons : ['No se pudo emitir el trabajo. Reintentá; si persiste, revisá la conexión del Runner y la configuración del servicio.'],
    at: new Date().toISOString(),
  };
  const ref = db.collection('issues').doc(issueId);
  await db.runTransaction(async (tx) => {
    const issue = (await tx.get(ref)).data();
    // A losing or delayed attempt must not hide a job successfully emitted
    // by a concurrent attempt, or report against a different executor.
    if (!issue || (issue.execution?.agentId || issue.assigneeId) !== agentId ||
      (issue.agent?.dispatchedAt && (issue.agent.dispatchedAt >= startedAt ||
        (issue.agent.dispatchedTo === agentId && Date.now() - Date.parse(issue.agent.dispatchedAt) < DISPATCH_COOLDOWN_MS)))) return;
    tx.update(ref, { 'agent.dispatchFailure': failure, 'agent.state': 'blocked', 'agent.blockedReason': failure.reasons.join(' ') });
  });
}
