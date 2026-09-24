import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { AgentRole, AgentQaMode, AgentVisibility } from '../../common/domain.generated';
import { getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

const AGENT_ROLES: AgentRole[] = ['dev', 'qa'];
const AGENT_QA_MODES: AgentQaMode[] = ['shadow', 'enforce'];
const AGENT_VISIBILITIES: AgentVisibility[] = ['personal', 'public'];

/** Fields a workspace member is allowed to change on an agent — notably
 * `autonomousMode`, the toggle that lets Fase 6's Firestore trigger dispatch
 * work to GitHub Actions without a human claiming the issue first, and
 * `qaMode`, whose only writer is a human in Settings — pasar a `enforce` es
 * una decisión explícita (D17). */
const AGENT_WRITABLE_FIELDS = [
  'autonomousMode',
  'enabled',
  'maxConcurrentIssues',
  'defaultRepo',
  'defaultTeamId',
  'role',
  'reviewRepo',
  'maxReviewAttempts',
  'qaMode',
  'runnerId',
  'allowedRepos',
  'visibility',
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
    if (data.role !== undefined && !AGENT_ROLES.includes(data.role)) {
      throw new Error(`role inválido: '${data.role}'. Debe ser 'dev' o 'qa'.`);
    }
    if (data.qaMode !== undefined && !AGENT_QA_MODES.includes(data.qaMode)) {
      throw new Error(`qaMode inválido: '${data.qaMode}'. Debe ser 'shadow' o 'enforce'.`);
    }
    if (data.visibility !== undefined && !AGENT_VISIBILITIES.includes(data.visibility)) {
      throw new Error(`visibility inválida: '${data.visibility}'. Debe ser 'personal' o 'public'.`);
    }

    const agentRef = db.collection('agents').doc(data.agentId);
    const snap = await agentRef.get();
    if (!snap.exists) {
      throw new Error(`El agente '${data.agentId}' no existe.`);
    }
    const agent = snap.data()!;
    const callerMember = await getWorkspaceMember(db, agent.workspaceId, this.caller.uid!);
    const callerIsAdmin = isWorkspaceAdmin(callerMember);
    const changingSettings = AGENT_WRITABLE_FIELDS.some((field) => data[field] !== undefined);
    if (agent.visibility === 'public' && !callerIsAdmin) {
      throw new Error('Solo un admin puede modificar un agente público.');
    }
    if (data.visibility === 'public' && !callerIsAdmin) {
      throw new Error('Solo un admin puede publicar un agente.');
    }
    if (agent.ownerMemberId && agent.ownerMemberId !== this.caller.uid && changingSettings && !callerIsAdmin) {
      throw new Error('Solo el dueño o un admin puede modificar este agente.');
    }

    const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
    for (const field of AGENT_WRITABLE_FIELDS) {
      if (data[field] !== undefined) updates[field] = data[field];
    }

    await agentRef.update(cleanUndefined(updates));
    const updated = (await agentRef.get()).data();

    if (updates.role !== undefined) {
      const memberId = `${this.resolvedWorkspaceId}_${data.agentId}`;
      await db.collection('members').doc(memberId).update({ agentRole: updates.role });
    }

    return { agent: updated };
  }
}
