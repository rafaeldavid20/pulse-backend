import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

export class GetAgentUsageAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.getUsage', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    return !!this.workspaceId && this.isWorkspaceMember(this.workspaceId);
  }

  protected auditResponse(response: Record<string, any>): Record<string, any> {
    return { agentCount: response.agents.length, runCount: response.runs.length };
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { from, to } = this.action.data;
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (typeof from !== 'string' || typeof to !== 'string' || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs || toMs - fromMs > 366 * 86400000) {
      throw new Error('from y to deben ser fechas válidas en un período de hasta 366 días.');
    }
    const db = getFirestore();
    const caller = await getWorkspaceMember(db, this.workspaceId!, this.caller.uid!);
    const agentsSnap = await db.collection('agents').where('workspaceId', '==', this.workspaceId).get();
    const agents = agentsSnap.docs.map((doc) => doc.data())
      .filter((agent) => agent.runnerId && (agent.kind === 'claude' || agent.kind === 'codex'))
      .filter((agent) => isWorkspaceAdmin(caller) || agent.ownerMemberId === this.caller.uid)
      .map((agent) => ({ id: agent.id, displayName: agent.displayName, kind: agent.kind, runnerId: agent.runnerId }));
    const visible = new Map(agents.map((agent) => [agent.id, agent.runnerId]));
    const runsSnap = await db.collection('agent_runs')
      .where('workspaceId', '==', this.workspaceId)
      .where('startedAt', '>=', new Date(fromMs).toISOString())
      .where('startedAt', '<=', new Date(toMs).toISOString())
      .get();
    const runs = runsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((run: any) => run.runnerId && visible.get(run.agentId) === run.runnerId)
      .map((run: any) => ({
        id: run.id, jobId: run.id, issueId: run.issueId, agentId: run.agentId,
        runnerId: run.runnerId, provider: run.provider || agents.find((agent) => agent.id === run.agentId)!.kind,
        mode: run.mode, startedAt: run.startedAt, outcome: run.runnerOutcome ?? run.outcome,
        ...(run.runUrl ? { runUrl: run.runUrl } : {}),
        usage: run.usage ?? null,
        ...(typeof run.costUsd === 'number' ? { costUsd: run.costUsd } : {}),
      }));
    return { agents, runs };
  }
}
