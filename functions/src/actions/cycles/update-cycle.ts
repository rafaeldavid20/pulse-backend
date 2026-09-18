import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { CYCLE_WRITABLE_FIELDS, CycleInitialScope } from '../../common/domain.generated';
import { pickWritableFields } from '../../common/utils/issue-fields';

export class UpdateCycleAction extends PlatformActionHandler {
  private cycleId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('cycles.update', request, callerUid, callerEmail);
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
      throw new Error('Identificador de ciclo (id) es obligatorio para actualizar.');
    }

    const cycleRef = db.collection('cycles').doc(cycleId);
    const snap = await cycleRef.get();
    if (!snap.exists) {
      throw new Error(`El ciclo con ID '${cycleId}' no existe.`);
    }
    const current = snap.data()!;

    if (current.status === 'completed') {
      throw new Error('El ciclo ya está cerrado: no se puede modificar.');
    }

    // `completed` solo puede salir de `cycles.close` (rollover + snapshot en
    // la misma operación) — dejarlo pasar acá dejaría un ciclo "cerrado" sin
    // ninguna de las dos cosas.
    if (data.status === 'completed') {
      throw new Error('Para cerrar un ciclo usá cycles.close, no cycles.update.');
    }

    const updates: Record<string, any> = cleanUndefined({
      ...pickWritableFields(data, CYCLE_WRITABLE_FIELDS),
      updatedAt: new Date().toISOString(),
    });

    const nextStartsAt = updates.startsAt ?? current.startsAt;
    const nextEndsAt = updates.endsAt ?? current.endsAt;
    if (new Date(nextStartsAt) >= new Date(nextEndsAt)) {
      throw new Error('startsAt debe ser anterior a endsAt.');
    }

    // E5: al arrancar el ciclo (upcoming -> active) se congela el scope
    // inicial una sola vez — si por lo que sea ya tiene `initialScope` (doble
    // click, reintento) no se vuelve a pisar, porque ahí deja de servir como
    // base fija para el burndown y el cálculo de `velocity` al cerrar.
    if (current.status === 'upcoming' && updates.status === 'active' && !current.initialScope) {
      updates.initialScope = await this.buildInitialScope(db, cycleId);
    }

    await cycleRef.update(updates);

    return { id: cycleId, ...updates };
  }

  private async buildInitialScope(db: Firestore, cycleId: string): Promise<CycleInitialScope> {
    const issuesSnap = await db.collection('issues').where('cycleId', '==', cycleId).get();
    const issueIds: string[] = [];
    const estimates: Record<string, number> = {};

    issuesSnap.forEach((doc) => {
      const estimate = doc.data().estimate;
      issueIds.push(doc.id);
      estimates[doc.id] = typeof estimate === 'number' ? estimate : 0;
    });

    return { issueIds, estimates };
  }
}
