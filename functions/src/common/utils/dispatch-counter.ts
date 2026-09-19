import { FieldValue, Firestore, Transaction } from 'firebase-admin/firestore';

/**
 * Circuit breaker diario de dispatches de agentes, compartido entre TODOS los
 * caminos (dev en `agent-dispatch.ts`, QA en `qa-dispatch.ts`, traspasos):
 * un solo contador por workspace y día, no uno por camino, para que ninguno
 * pueda gastar el presupuesto del otro por separado (TES-149).
 */
export const DAILY_DISPATCH_LIMIT = 5;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function counterDocId(workspaceId: string): string {
  return `${workspaceId}_${today()}`;
}

/**
 * Lee y, si hay lugar, incrementa el contador diario dentro de una
 * transacción ya abierta por el caller (que también necesita leer/escribir el
 * propio issue en la misma transacción para no perder la carrera contra otro
 * trigger concurrente). Devuelve si el dispatch está permitido.
 */
export async function tryConsumeDailyDispatch(
  tx: Transaction,
  db: Firestore,
  workspaceId: string
): Promise<boolean> {
  const counterRef = db.collection('agent_dispatch_counters').doc(counterDocId(workspaceId));
  const counterSnap = await tx.get(counterRef);
  const count = counterSnap.exists ? counterSnap.data()!.count || 0 : 0;
  if (count >= DAILY_DISPATCH_LIMIT) return false;

  tx.set(counterRef, { workspaceId, date: today(), count: FieldValue.increment(1) }, { merge: true });
  return true;
}
