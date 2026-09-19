import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { DAILY_DISPATCH_LIMIT, todayKey } from '../../common/utils/dispatch-counter';

/**
 * Resumen de gasto/dispatches de hoy para el workspace (D8/TES-153): lo que
 * la sección de Settings muestra como "hoy: 3/5 dispatches · USD 4,20/10",
 * desglosado por rol. `agent_dispatch_counters` y `agent_runs` son
 * Admin-SDK-only (ver `firestore.rules`), así que el frontend no puede
 * calcular esto leyendo Firestore directamente — necesita esta acción.
 */
export class GetAgentBudgetAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('workspaces.getAgentBudget', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    const workspaceSnap = await db.collection('workspaces').doc(data.workspaceId).get();
    const workspace = workspaceSnap.exists ? workspaceSnap.data()! : {};

    const today = todayKey();
    const counterSnap = await db.collection('agent_dispatch_counters').doc(`${data.workspaceId}_${today}`).get();
    const dispatchesToday = counterSnap.exists ? counterSnap.data()!.count || 0 : 0;

    const runsSnap = await db
      .collection('agent_runs')
      .where('workspaceId', '==', data.workspaceId)
      .where('date', '==', today)
      .get();

    const byRole: Record<string, { dispatches: number; costUsd: number }> = {
      dev: { dispatches: 0, costUsd: 0 },
      qa: { dispatches: 0, costUsd: 0 },
    };
    let costUsdToday = 0;
    for (const doc of runsSnap.docs) {
      const run = doc.data();
      const role: string = run.role === 'qa' ? 'qa' : 'dev';
      const costUsd: number = run.costUsd || 0;
      byRole[role].dispatches += 1;
      byRole[role].costUsd += costUsd;
      costUsdToday += costUsd;
    }

    return {
      agentsPaused: !!workspace.agentsPaused,
      dispatchesToday,
      dailyDispatchLimit: workspace.dailyDispatchLimit ?? DAILY_DISPATCH_LIMIT,
      costUsdToday,
      dailyCostCapUsd: workspace.dailyCostCapUsd ?? null,
      byRole,
    };
  }
}
