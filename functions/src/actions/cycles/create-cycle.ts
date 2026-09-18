import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { nextCycleNumber } from '../../common/utils/counters';

export class CreateCycleAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('cycles.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.teamId || !data.startsAt || !data.endsAt) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, teamId, startsAt, endsAt.');
    }

    if (new Date(data.startsAt) >= new Date(data.endsAt)) {
      throw new Error('startsAt debe ser anterior a endsAt.');
    }

    const cycleId = `cycle-${nanoid(8)}`;
    const number = await nextCycleNumber(db, data.workspaceId, data.teamId);

    const rawCycle = {
      id: cycleId,
      workspaceId: data.workspaceId,
      teamId: data.teamId,
      number,
      name: (data.name || `Ciclo ${number}`).trim(),
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      status: data.status || 'upcoming',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cleanCycle = cleanUndefined(rawCycle);
    await db.collection('cycles').doc(cycleId).set(cleanCycle);

    return cleanCycle;
  }
}
