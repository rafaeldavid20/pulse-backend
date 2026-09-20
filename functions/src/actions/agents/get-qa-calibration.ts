import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Tasa de acuerdo humano/QA de las últimas N revisiones (D17/TES-213), para
 * la vista del agente QA en D7. `qa_calibration_records` y `agents` son
 * Admin-SDK-only (ver `firestore.rules`), así que el frontend no puede
 * calcular esto leyendo Firestore directamente — necesita esta acción, mismo
 * criterio que `workspaces.getAgentBudget`.
 */
export class GetQaCalibrationAction extends PlatformActionHandler {
  private agentId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.getQaCalibration', request, callerUid, callerEmail);
    this.agentId = request.data?.agentId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.agentId) return false;
    const snap = await getFirestore().collection('agents').doc(this.agentId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.agentId) {
      throw new Error('Parámetro requerido faltante: agentId.');
    }

    const agentSnap = await db.collection('agents').doc(data.agentId).get();
    if (!agentSnap.exists) {
      throw new Error(`El agente '${data.agentId}' no existe.`);
    }
    const agent = agentSnap.data()!;

    const limit = Math.min(Math.max(1, data.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const recordsSnap = await db
      .collection('qa_calibration_records')
      .where('agentId', '==', data.agentId)
      .orderBy('decidedAt', 'desc')
      .limit(limit)
      .get();

    const records = recordsSnap.docs.map((d) => d.data());
    const agreed = records.filter((r) => r.agreed).length;
    const total = records.length;

    return {
      agentId: data.agentId,
      qaMode: agent.qaMode === 'enforce' ? 'enforce' : 'shadow',
      sampleSize: total,
      agreed,
      disagreed: total - agreed,
      agreementRate: total > 0 ? agreed / total : null,
      records,
    };
  }
}
