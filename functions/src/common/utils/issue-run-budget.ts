import { Firestore } from 'firebase-admin/firestore';

/**
 * Default de `Workspace.maxRunsPerIssue` (D8/TES-153): el bug que motivó esta
 * historia — un issue con dos rechazos consume dev + QA + re-trabajo + QA +
 * re-trabajo = 5 runs, agotando `DAILY_DISPATCH_LIMIT` con un solo issue. Este
 * tope es sobre el TOTAL de runs de un issue (task + traspasos + QA, contados
 * en `agent_runs`), no sobre los intentos de revisión — cubre bucles que
 * nunca llegan a QA, como un traspaso que se re-pide una y otra vez.
 */
export const DEFAULT_MAX_RUNS_PER_ISSUE = 6;

export type IssueRunBudgetReason = 'issue-run-limit' | 'issue-cost-cap';

export type IssueRunBudgetDecision =
  | { withinBudget: true }
  | { withinBudget: false; reason: IssueRunBudgetReason; limit?: number; capUsd?: number };

/**
 * Chequeo previo a despachar un run (task, traspaso o revisión) para un issue
 * puntual: cuenta y suma `agent_runs` de ese issue contra
 * `Workspace.maxRunsPerIssue` (default `DEFAULT_MAX_RUNS_PER_ISSUE`) y
 * `Workspace.issueCostCapUsd` (sin tope si no está seteado).
 *
 * No transaccional a propósito: el caller lo evalúa ANTES de abrir la
 * transacción de dispatch (mismo lugar que ya ocupaba el chequeo de
 * `maxReviewAttempts` en `qa-dispatch.ts`), porque cuando se agota el tope el
 * caller tiene que escalar el issue a un humano, no solo saltear el dispatch.
 */
export async function checkIssueRunBudget(
  db: Firestore,
  workspaceId: string,
  issueId: string
): Promise<IssueRunBudgetDecision> {
  const wsSnap = await db.collection('workspaces').doc(workspaceId).get();
  const workspace = wsSnap.exists ? wsSnap.data()! : {};
  const maxRuns: number = workspace.maxRunsPerIssue ?? DEFAULT_MAX_RUNS_PER_ISSUE;
  const costCapUsd: number | undefined = workspace.issueCostCapUsd;

  const runsSnap = await db.collection('agent_runs').where('issueId', '==', issueId).get();
  if (runsSnap.size >= maxRuns) {
    return { withinBudget: false, reason: 'issue-run-limit', limit: maxRuns };
  }
  if (costCapUsd) {
    const spentUsd = runsSnap.docs.reduce((sum, doc) => sum + (doc.data().costUsd || 0), 0);
    if (spentUsd >= costCapUsd) return { withinBudget: false, reason: 'issue-cost-cap', capUsd: costCapUsd };
  }

  return { withinBudget: true };
}
