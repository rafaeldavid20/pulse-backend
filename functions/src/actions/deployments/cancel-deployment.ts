import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

/**
 * `deployments.cancel`: marca como cancelado un deploy que quedó `running` (el
 * run murió sin reportar) o `awaiting_approval`. No cancela nada en la org ni
 * en GitHub: es para que Pulse deje de mostrar como en curso algo que no lo está.
 */
export class CancelDeploymentAction extends PlatformActionHandler {
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('deployments.cancel', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    const id = this.action.data?.deploymentId;
    if (!id) return false;
    const snap = await getFirestore().collection('deployments').doc(id).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const ref = getFirestore().collection('deployments').doc(this.action.data.deploymentId);
    const dep = (await ref.get()).data()!;
    if (dep.status !== 'running' && dep.status !== 'awaiting_approval') {
      throw new Error(`El deploy ya terminó (${dep.status}); no hay nada que cancelar.`);
    }
    await ref.update({ status: 'canceled', endedAt: new Date().toISOString() });
    return { deploymentId: dep.id, status: 'canceled' };
  }
}
