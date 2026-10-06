import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { canManageAgent, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';
import { runnerPreflight } from '../../common/utils/runner-preflight';

export class PreflightAgentAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) { super('runners.preflight', request, callerUid, callerEmail); }
  protected async authorize(): Promise<boolean> {
    const id = this.action.data.agentId;
    if (typeof id !== 'string' || !id) return false;
    const agent = await getFirestore().collection('agents').doc(id).get();
    return agent.exists && this.isWorkspaceMember(agent.data()!.workspaceId);
  }
  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const snap = await db.collection('agents').doc(this.action.data.agentId).get();
    const agent = { ...snap.data()!, id: snap.id } as any;
    const caller = await getWorkspaceMember(db, agent.workspaceId, this.caller.uid!);
    if (!canManageAgent(agent, this.caller.uid!, isWorkspaceAdmin(caller))) throw new Error('Solo el dueño o un admin puede verificar este agente.');
    const runnerSnap = agent.runnerId ? await db.collection('runners').doc(agent.runnerId).get() : null;
    const runner = runnerSnap?.exists ? { ...runnerSnap.data(), id: runnerSnap.id } : null;
    if (runner && (runner as any).workspaceId !== agent.workspaceId) throw new Error('El Runner no pertenece a este workspace.');
    if (runner && (runner as any).ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(caller)) throw new Error('Solo el dueño o un admin puede consultar este Runner.');
    const requested = this.action.data.repos;
    if (!Array.isArray(requested) || requested.length > 100 || requested.some((repo) => typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))) throw new Error('repos debe contener repositorios owner/repo.');
    const result = runnerPreflight(agent, runner, agent.workspaceId, requested, agent.role === 'qa' ? 'review' : 'task', Date.now(), true);
    if (runner) {
      const jobs = await db.collection('runner_jobs').where('runnerId', '==', agent.runnerId).get();
      const active = jobs.docs.filter((job) => ['pending', 'delivered'].includes(job.data().status) && Date.parse(job.data().expiresAt) > Date.now()).length;
      if (active >= ((runner as any).maxConcurrentJobs || 1)) {
        result.ready = false;
        result.problems.push({ code: 'capacity', message: 'El Runner alcanzó su capacidad de jobs activos.', action: 'Esperá a que termine el job activo o seleccioná otro Runner compatible.' });
      }
    }
    return { ...result, agentId: agent.id, runnerId: agent.runnerId || null, provider: agent.kind, role: agent.role };
  }
}
