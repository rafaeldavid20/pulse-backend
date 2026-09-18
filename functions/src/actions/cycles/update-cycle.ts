import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { CYCLE_WRITABLE_FIELDS } from '../../common/domain.generated';
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

    await cycleRef.update(updates);

    return { id: cycleId, ...updates };
  }
}
