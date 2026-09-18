import { getFirestore, FieldValue, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { isCompletedStatus } from '../../common/domain.generated';

const BATCH_SIZE = 400;

/**
 * Cierra un ciclo: congela un snapshot de scope/completado/velocidad y hace el
 * rollover básico de los issues no terminados (blanket move-to-next-or-backlog
 * — qué issue va a dónde según su status puntual es E5).
 *
 * `data.rolloverTo` es opcional y hace el destino configurable por llamada, en
 * vez de una config persistida por equipo (eso, si hace falta, es de E4):
 *   - omitido: al próximo ciclo `upcoming` del equipo (el de `startsAt` más
 *     próximo), o al backlog si no hay ninguno.
 *   - `'backlog'`: fuerza backlog aunque exista un próximo ciclo.
 *   - un id de ciclo: fuerza ese ciclo como destino (debe ser del mismo equipo).
 */
export class CloseCycleAction extends PlatformActionHandler {
  private cycleId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('cycles.close', request, callerUid, callerEmail);
    this.cycleId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.cycleId) return false;
    const snap = await getFirestore().collection('cycles').doc(this.cycleId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const cycleId = data.id as string | undefined;

    if (!cycleId) {
      throw new Error('Identificador de ciclo (id) es obligatorio para cerrar.');
    }

    const cycleRef = db.collection('cycles').doc(cycleId);
    const cycleSnap = await cycleRef.get();
    if (!cycleSnap.exists) {
      throw new Error(`El ciclo con ID '${cycleId}' no existe.`);
    }
    const cycle = cycleSnap.data()!;

    if (cycle.status === 'completed') {
      throw new Error('El ciclo ya está cerrado.');
    }

    // Resuelve el destino del rollover *antes* de tocar los issues: si
    // `rolloverTo` apunta a un ciclo inválido, no queremos dejar issues a
    // medio mover.
    const targetCycle = await this.resolveTarget(db, cycle.teamId, cycleId, data.rolloverTo);

    const issuesSnap = await db.collection('issues').where('cycleId', '==', cycleId).get();

    let scope = 0;
    let completed = 0;
    let velocity = 0;
    const toRollover: QueryDocumentSnapshot[] = [];

    issuesSnap.forEach((doc) => {
      const issue = doc.data();
      const points = typeof issue.estimate === 'number' ? issue.estimate : 0;
      scope += points;

      // "Completado" sigue la misma noción de cerrado que el resto del
      // dominio (`isCompletedStatus`: done + canceled no dejan trabajo
      // pendiente). "Velocidad" es más estricta a propósito — solo `done` —
      // porque es lo que E2 promedia sobre los últimos 3 ciclos para sugerir
      // cuánto meter en el próximo, y contar puntos cancelados ahí infla esa
      // referencia con trabajo que nunca se entregó.
      if (isCompletedStatus(issue.status)) {
        completed += points;
        if (issue.status === 'done') velocity += points;
      } else {
        toRollover.push(doc);
      }
    });

    await this.rollover(db, toRollover, targetCycle);

    const updatedAt = new Date().toISOString();
    const snapshot = { scope, completed, velocity };
    await cycleRef.update({ status: 'completed', snapshot, updatedAt });

    return {
      id: cycleId,
      status: 'completed',
      snapshot,
      rolledOverCount: toRollover.length,
      targetCycleId: targetCycle?.id ?? null,
    };
  }

  private async resolveTarget(
    db: FirebaseFirestore.Firestore,
    teamId: string,
    cycleId: string,
    rolloverTo: unknown
  ): Promise<{ id: string } | null> {
    if (rolloverTo === 'backlog') return null;

    if (typeof rolloverTo === 'string' && rolloverTo.length > 0) {
      const targetSnap = await db.collection('cycles').doc(rolloverTo).get();
      if (!targetSnap.exists) {
        throw new Error(`El ciclo destino '${rolloverTo}' no existe.`);
      }
      if (targetSnap.data()!.teamId !== teamId) {
        throw new Error('El ciclo destino pertenece a otro equipo.');
      }
      if (targetSnap.id === cycleId) {
        throw new Error('El ciclo destino no puede ser el mismo ciclo que se está cerrando.');
      }
      return { id: targetSnap.id };
    }

    const nextSnap = await db
      .collection('cycles')
      .where('teamId', '==', teamId)
      .where('status', '==', 'upcoming')
      .orderBy('startsAt', 'asc')
      .limit(1)
      .get();

    return nextSnap.empty ? null : { id: nextSnap.docs[0].id };
  }

  private async rollover(
    db: FirebaseFirestore.Firestore,
    docs: QueryDocumentSnapshot[],
    targetCycle: { id: string } | null
  ): Promise<void> {
    if (docs.length === 0) return;
    const updatedAt = new Date().toISOString();

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + BATCH_SIZE)) {
        batch.update(doc.ref, {
          cycleId: targetCycle ? targetCycle.id : FieldValue.delete(),
          updatedAt,
        });
      }
      await batch.commit();
    }
  }
}
