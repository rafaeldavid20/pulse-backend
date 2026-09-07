import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

/** Fields a workspace member is allowed to change on an agent — notably
 * `autonomousMode`, the toggle that lets Fase 6's Firestore trigger dispatch
 * work to GitHub Actions without a human claiming the issue first. */
const AGENT_WRITABLE_FIELDS = [
  'autonomousMode',
  'enabled',
  'maxConcurrentIssues',
  'defaultRepo',
  'defaultTeamId',
] as const;

export class UpdateAgentAction extends PlatformActionHandler {
  private agentId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.update', request, callerUid, callerEmail);
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

    const agentRef = db.collection('agents').doc(data.agentId);
    const snap = await agentRef.get();
    if (!snap.exists) {
      throw new Error(`El agente '${data.agentId}' no existe.`);
    }

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    for (const field of AGENT_WRITABLE_FIELDS) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    await agentRef.update(cleanUndefined(updates));
    const updated = (await agentRef.get()).data();

    return { agent: updated };
  }
}
