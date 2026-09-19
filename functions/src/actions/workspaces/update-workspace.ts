import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

/**
 * Guardarraíles de costo y seguridad configurables por workspace (D8/TES-153):
 * el kill switch (`agentsPaused`), el tope diario de dispatches y los techos
 * de gasto/runs por día e issue. Lo que muestra el botón "Pausar agentes" del
 * command palette y la sección de Settings.
 */
const WORKSPACE_WRITABLE_FIELDS = [
  'agentsPaused',
  'dailyDispatchLimit',
  'dailyCostCapUsd',
  'issueCostCapUsd',
  'maxRunsPerIssue',
] as const;

const POSITIVE_INT_FIELDS = ['dailyDispatchLimit', 'maxRunsPerIssue'] as const;
const NON_NEGATIVE_NUMBER_FIELDS = ['dailyCostCapUsd', 'issueCostCapUsd'] as const;

export class UpdateWorkspaceAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('workspaces.update', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  // minRole: 'admin' — pausar agentes o subir los techos de gasto es una
  // operación con implicancia de costo real; "cualquier miembro" no alcanza
  // (mismo criterio que `workspaces.inviteMember`).
  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.assertWorkspaceMember(this.workspaceId, 'admin');
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    const workspaceRef = db.collection('workspaces').doc(data.workspaceId);
    const snap = await workspaceRef.get();
    if (!snap.exists) {
      throw new Error(`El workspace '${data.workspaceId}' no existe.`);
    }

    if (data.agentsPaused !== undefined && typeof data.agentsPaused !== 'boolean') {
      throw new Error('agentsPaused debe ser booleano.');
    }
    for (const field of POSITIVE_INT_FIELDS) {
      const value = data[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)) {
        throw new Error(`${field} debe ser un entero positivo.`);
      }
    }
    for (const field of NON_NEGATIVE_NUMBER_FIELDS) {
      const value = data[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`${field} debe ser un número mayor o igual a 0.`);
      }
    }

    const updates: Record<string, any> = {};
    for (const field of WORKSPACE_WRITABLE_FIELDS) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    await workspaceRef.update(cleanUndefined(updates));
    const updated = (await workspaceRef.get()).data();

    return { workspace: updated };
  }
}
