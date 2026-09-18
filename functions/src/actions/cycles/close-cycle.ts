import { getFirestore, FieldValue, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { isCompletedStatus, CycleInitialScope } from '../../common/domain.generated';

// Cada issue rolleado escribe 2 documentos (el update del issue + su
// comentario de sistema) en el mismo batch, así que la mitad del límite de
// 500 escrituras por batch de Firestore.
const BATCH_SIZE = 200;

interface RolloverTarget {
  id: string;
  name: string;
}

/**
 * Cierra un ciclo: congela un snapshot de scope/completado/velocidad/carryover
 * y hace el rollover de los issues no terminados **por status** (E5):
 *   - `todo` / `in_progress` (o cualquier otro status no completado que no sea
 *     `backlog`, p. ej. `in_review`) → pasan al siguiente ciclo `upcoming` del
 *     equipo, o a backlog si no hay uno.
 *   - `backlog` → siempre vuelve a backlog (`cycleId: null`), sin importar si
 *     hay un próximo ciclo: ya había vuelto a planeación antes de que este
 *     ciclo cerrara, cerrarlo no lo vuelve a meter a la fuerza.
 *   - `done` / `canceled` → no se tocan.
 * Cada issue movido recibe un comentario de sistema logueando el rollover.
 *
 * `data.rolloverTo` es opcional y hace el destino del rollover "hacia
 * adelante" (todo/in_progress/etc., no backlog) configurable por llamada, en
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
    const initialScope = cycle.initialScope as CycleInitialScope | undefined;
    const initialScopeIds = new Set(initialScope?.issueIds ?? []);

    let scope = 0;
    let completed = 0;
    let velocity = 0;
    let carryoverPoints = 0;
    const backlogDocs: QueryDocumentSnapshot[] = [];
    const forwardDocs: QueryDocumentSnapshot[] = [];

    issuesSnap.forEach((doc) => {
      const issue = doc.data();
      const points = typeof issue.estimate === 'number' ? issue.estimate : 0;
      scope += points;

      if (isCompletedStatus(issue.status)) {
        completed += points;
        if (issue.status === 'done') {
          // `velocity` es más estricta que `completed` a propósito (E5): solo
          // cuenta puntos de issues que ya estaban en `initialScope`, para que
          // el scope agregado a mitad de ciclo no infle lo que E2 promedia
          // sobre los últimos 3 ciclos. Un ciclo que nunca pasó por la
          // transición `upcoming -> active` (y por lo tanto no tiene
          // `initialScope`) cae al comportamiento anterior a E5, porque no hay
          // forma de distinguir qué era scope inicial.
          if (!initialScope) {
            velocity += points;
          } else if (initialScopeIds.has(doc.id)) {
            velocity += initialScope.estimates[doc.id] ?? 0;
          }
        }
        return;
      }

      if (issue.status === 'backlog') {
        backlogDocs.push(doc);
      } else {
        forwardDocs.push(doc);
        carryoverPoints += points;
      }
    });

    await this.rollover(db, backlogDocs, null, cycle.name);
    await this.rollover(db, forwardDocs, targetCycle, cycle.name);

    const carryover = scope > 0 ? Math.round((carryoverPoints / scope) * 100) : 0;

    const updatedAt = new Date().toISOString();
    const snapshot = { scope, completed, velocity, carryover };
    await cycleRef.update({ status: 'completed', snapshot, updatedAt });

    return {
      id: cycleId,
      status: 'completed',
      snapshot,
      rolledOverCount: backlogDocs.length + forwardDocs.length,
      targetCycleId: targetCycle?.id ?? null,
    };
  }

  private async resolveTarget(
    db: FirebaseFirestore.Firestore,
    teamId: string,
    cycleId: string,
    rolloverTo: unknown
  ): Promise<RolloverTarget | null> {
    if (rolloverTo === 'backlog') return null;

    if (typeof rolloverTo === 'string' && rolloverTo.length > 0) {
      const targetSnap = await db.collection('cycles').doc(rolloverTo).get();
      if (!targetSnap.exists) {
        throw new Error(`El ciclo destino '${rolloverTo}' no existe.`);
      }
      const targetData = targetSnap.data()!;
      if (targetData.teamId !== teamId) {
        throw new Error('El ciclo destino pertenece a otro equipo.');
      }
      if (targetSnap.id === cycleId) {
        throw new Error('El ciclo destino no puede ser el mismo ciclo que se está cerrando.');
      }
      return { id: targetSnap.id, name: targetData.name };
    }

    const nextSnap = await db
      .collection('cycles')
      .where('teamId', '==', teamId)
      .where('status', '==', 'upcoming')
      .orderBy('startsAt', 'asc')
      .limit(1)
      .get();

    if (nextSnap.empty) return null;
    const nextDoc = nextSnap.docs[0];
    return { id: nextDoc.id, name: nextDoc.data().name };
  }

  /**
   * Mueve `docs` a `target` (o a backlog si es `null`) y deja, por cada uno,
   * un comentario de sistema logueando el rollover. `sourceCycleName` es el
   * nombre del ciclo que se está cerrando, para que el comentario tenga
   * sentido leído fuera de contexto.
   */
  private async rollover(
    db: FirebaseFirestore.Firestore,
    docs: QueryDocumentSnapshot[],
    target: RolloverTarget | null,
    sourceCycleName: string
  ): Promise<void> {
    if (docs.length === 0) return;
    const updatedAt = new Date().toISOString();

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + BATCH_SIZE)) {
        const issue = doc.data();
        batch.update(doc.ref, {
          cycleId: target ? target.id : FieldValue.delete(),
          updatedAt,
        });

        const commentId = `cmt-${nanoid(8)}`;
        batch.set(db.collection('comments').doc(commentId), {
          id: commentId,
          workspaceId: issue.workspaceId,
          issueId: doc.id,
          authorId: 'system',
          body: this.rolloverCommentBody(issue.status, sourceCycleName, target),
          source: 'web',
          createdAt: updatedAt,
        });
      }
      await batch.commit();
    }
  }

  private rolloverCommentBody(issueStatus: string, sourceCycleName: string, target: RolloverTarget | null): string {
    if (issueStatus === 'backlog') {
      return (
        `🔄 Rollover automático: vuelve a **Backlog** (sin ciclo) al cerrarse **${sourceCycleName}** ` +
        `— ya estaba en estado \`backlog\`.`
      );
    }
    if (target) {
      return (
        `🔄 Rollover automático: pasa de **${sourceCycleName}** a **${target.name}** al cerrarse este ciclo ` +
        `(estado \`${issueStatus}\` sin completar).`
      );
    }
    return (
      `🔄 Rollover automático: pasa a **Backlog** al cerrarse **${sourceCycleName}** ` +
      `— no hay un próximo ciclo (estado \`${issueStatus}\` sin completar).`
    );
  }
}
