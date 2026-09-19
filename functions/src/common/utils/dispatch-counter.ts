import { FieldValue, Firestore, Transaction } from 'firebase-admin/firestore';

/**
 * Circuit breaker diario de dispatches de agentes, compartido entre TODOS los
 * caminos (dev en `agent-dispatch.ts`, QA en `qa-dispatch.ts`, traspasos):
 * un solo contador por workspace y día, no uno por camino, para que ninguno
 * pueda gastar el presupuesto del otro por separado (TES-149).
 *
 * Default cuando el workspace no define `Workspace.dailyDispatchLimit`
 * (D8/TES-153).
 */
export const DAILY_DISPATCH_LIMIT = 5;

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function counterDocId(workspaceId: string): string {
  return `${workspaceId}_${todayKey()}`;
}

export type WorkspaceBudgetReason = 'paused' | 'daily-dispatch-limit' | 'daily-cost-cap';

export type WorkspaceBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: WorkspaceBudgetReason; limit?: number; capUsd?: number };

/**
 * Lee y, si hay lugar, incrementa el contador diario dentro de una
 * transacción ya abierta por el caller (que también necesita leer/escribir el
 * propio issue en la misma transacción para no perder la carrera contra otro
 * trigger concurrente). Encapsula los tres guardarraíles a nivel workspace
 * (D8/TES-153): el kill switch `agentsPaused`, el tope diario de dispatches
 * (configurable por workspace) y el techo diario de gasto en USD basado en
 * `agent_runs.costUsd` (D15, todavía sin poblar — mientras tanto esta
 * comparación no bloquea nada porque no hay `costUsd` que sumar).
 *
 * Todas las lecturas (workspace, contador, y la query de costo si aplica)
 * pasan antes que la única escritura (el incremento del contador), como
 * exige una transacción de Firestore.
 */
export async function checkWorkspaceDispatchBudget(
  tx: Transaction,
  db: Firestore,
  workspaceId: string
): Promise<WorkspaceBudgetDecision> {
  const wsSnap = await tx.get(db.collection('workspaces').doc(workspaceId));
  const workspace = wsSnap.exists ? wsSnap.data()! : {};
  if (workspace.agentsPaused) return { allowed: false, reason: 'paused' };

  const limit = workspace.dailyDispatchLimit ?? DAILY_DISPATCH_LIMIT;
  const counterRef = db.collection('agent_dispatch_counters').doc(counterDocId(workspaceId));
  const counterSnap = await tx.get(counterRef);
  const count = counterSnap.exists ? counterSnap.data()!.count || 0 : 0;
  if (count >= limit) return { allowed: false, reason: 'daily-dispatch-limit', limit };

  const dailyCostCapUsd: number | undefined = workspace.dailyCostCapUsd;
  if (dailyCostCapUsd) {
    const runsSnap = await tx.get(
      db.collection('agent_runs').where('workspaceId', '==', workspaceId).where('date', '==', todayKey())
    );
    const spentUsd = runsSnap.docs.reduce((sum, doc) => sum + (doc.data().costUsd || 0), 0);
    if (spentUsd >= dailyCostCapUsd) return { allowed: false, reason: 'daily-cost-cap', capUsd: dailyCostCapUsd };
  }

  tx.set(counterRef, { workspaceId, date: todayKey(), count: FieldValue.increment(1) }, { merge: true });
  return { allowed: true };
}
