import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentVisibility, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

/** Assigns an executor without replacing the human accountable for the issue. */
export class AssignExecutionAgentAction extends PlatformActionHandler {
  private issueId?: string;
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.assignExecutionAgent', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.workspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const { issueId, agentId } = this.action.data;
    const callerUid = this.caller.uid!;
    const issueRef = db.collection('issues').doc(issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue '${issueId}' no existe.`);
    const issue = issueSnap.data()!;
    const caller = await getWorkspaceMember(db, issue.workspaceId, callerUid);
    const responsibleMemberId = issue.responsibleMemberId || issue.assigneeId;

    if (!agentId) {
      await issueRef.update({ execution: null, updatedAt: new Date().toISOString(), updatedBy: callerUid });
      return { issueId, execution: null };
    }
    if (!responsibleMemberId) {
      throw new Error('Asigná primero un responsable humano antes de elegir un agente ejecutor.');
    }

    const agentSnap = await db.collection('agents').doc(agentId).get();
    if (!agentSnap.exists || agentSnap.data()!.workspaceId !== issue.workspaceId) {
      throw new Error(`El agente '${agentId}' no existe en este workspace.`);
    }
    const agent = agentSnap.data()!;
    const visibility = agentVisibility(agent);
    const callerIsAdmin = isWorkspaceAdmin(caller);

    if (visibility === 'public') {
      if (!callerIsAdmin) throw new Error('Solo un admin puede asignar agentes públicos.');
    } else if (agent.ownerMemberId !== callerUid || responsibleMemberId !== callerUid) {
      throw new Error('Solo podés asignar tus agentes personales a issues de los que sos responsable.');
    }

    const now = new Date().toISOString();
    const execution = { agentId, assignedBy: callerUid, assignedAt: now, mode: visibility };
    await issueRef.update({ execution, updatedAt: now, updatedBy: callerUid });
    return { issueId, execution };
  }
}
