import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentVisibility, canDeleteAgent, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

const ACTIVE_JOB_STATUSES = new Set(['pending', 'delivered']);

abstract class AgentLifecycleAction extends PlatformActionHandler {
  protected agentId?: string;
  protected workspaceId?: string;

  protected constructor(actionCode: 'agents.archive' | 'agents.restore', request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super(actionCode, request, callerUid, callerEmail);
    this.agentId = request.data?.agentId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.agentId) return false;
    const snap = await getFirestore().collection('agents').doc(this.agentId).get();
    if (!snap.exists) return false;
    this.workspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async getOwnedAgent() {
    if (!this.agentId) throw new Error('Parámetro requerido faltante: agentId.');
    const db = getFirestore();
    const agentRef = db.collection('agents').doc(this.agentId);
    const snap = await agentRef.get();
    if (!snap.exists) throw new Error(`El agente '${this.agentId}' no existe.`);
    const agent = snap.data()!;
    const callerUid = this.caller.uid!;
    const caller = await getWorkspaceMember(db, agent.workspaceId, callerUid);
    if (!canDeleteAgent(agent, callerUid, isWorkspaceAdmin(caller))) {
      throw new Error(agentVisibility(agent) === 'public'
        ? 'Solo el admin que creó este agente público puede cambiar su estado.'
        : 'Solo el dueño de este agente personal puede cambiar su estado.');
    }
    return { db, agentRef, agent };
  }
}

/** Archives an agent without deleting its historical runs, jobs or issue refs. */
export class ArchiveAgentAction extends AgentLifecycleAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.archive', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { db, agentRef, agent } = await this.getOwnedAgent();
    if (agent.archivedAt) return { agent };

    const archivedAt = new Date().toISOString();
    const jobsQuery = db.collection('runner_jobs').where('agentId', '==', this.agentId);
    await db.runTransaction(async (transaction) => {
      const [currentAgent, jobs] = await Promise.all([transaction.get(agentRef), transaction.get(jobsQuery)]);
      if (!currentAgent.exists) throw new Error(`El agente '${this.agentId}' no existe.`);
      if (currentAgent.data()?.archivedAt) return;
      const now = Date.now();
      const hasActiveJobs = jobs.docs.some((job) => {
        const data = job.data();
        if (!ACTIVE_JOB_STATUSES.has(data.status)) return false;
        if (!data.expiresAt) return true;
        const expiresAt = typeof data.expiresAt?.toDate === 'function'
          ? data.expiresAt.toDate().getTime()
          : new Date(data.expiresAt).getTime();
        return !Number.isFinite(expiresAt) || expiresAt > now;
      });
      if (hasActiveJobs) {
        throw new Error('No se puede archivar el agente mientras tenga jobs activos. Esperá a que terminen o expiren y volvé a intentarlo.');
      }
      transaction.update(agentRef, { archivedAt, archivedBy: this.caller.uid, updatedAt: archivedAt });
    });
    return { agent: { ...agent, archivedAt, archivedBy: this.caller.uid, updatedAt: archivedAt } };
  }
}

/** Restores an archived agent; all historical records remained attached. */
export class RestoreAgentAction extends AgentLifecycleAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.restore', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { agentRef, agent } = await this.getOwnedAgent();
    if (!agent.archivedAt) return { agent };
    const now = new Date().toISOString();
    await agentRef.update({
      archivedAt: FieldValue.delete(),
      archivedBy: FieldValue.delete(),
      updatedAt: now,
    });
    const restored: Record<string, any> = { ...agent, updatedAt: now };
    delete restored.archivedAt;
    delete restored.archivedBy;
    return { agent: restored };
  }
}
