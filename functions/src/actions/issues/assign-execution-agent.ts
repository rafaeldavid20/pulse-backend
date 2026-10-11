import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentVisibility, canAssignExecutionAgent } from '../../common/utils/agent-authorization';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import { runnerProjectRepoAccess } from '../../common/utils/project-repos';

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
    if (agent.archivedAt) throw new Error('No se puede asignar un agente archivado. Restauralo primero.');
    const visibility = agentVisibility(agent);
    if (!canAssignExecutionAgent(agent, callerUid, responsibleMemberId)) {
      throw new Error(
        visibility === 'public'
          ? 'Los agentes públicos se asignan mediante procesos del workspace, no desde la asignación manual.'
          : 'Solo podés asignar tus agentes personales a issues de los que sos responsable.'
      );
    }

    // Validate permanent routing requirements before accepting an executor.
    // Availability is checked at dispatch: an offline Runner can still be assigned.
    if (agent.runnerId) {
      if (!issue.projectId) {
        throw new Error('Elegí un proyecto con repositorios configurados antes de asignar el agente ejecutor.');
      }
      const installations = await db.collection('github_installations')
        .where('workspaceId', '==', issue.workspaceId).get();
      const installationRepos: string[] = [...new Set(installations.docs.flatMap((doc) =>
        doc.data().suspendedAt ? [] : doc.data().repositoryFullNames || []
      ))];
      const access = await runnerProjectRepoAccess(db, issue, installationRepos);
      if (!access || access.repos.length === 0) {
        throw new Error('Configurá repositorios en el proyecto y habilitalos en la instalación GitHub del workspace antes de asignar el agente ejecutor.');
      }
      const { repoFullName } = await resolveIssueRepo(db, issue, { agentId, installationRepos });
      if (!repoFullName || !access.repos.includes(repoFullName)) {
        throw new Error('Elegí un repositorio de la issue que pertenezca al proyecto y esté habilitado en GitHub antes de asignar el agente ejecutor.');
      }
    }

    const now = new Date().toISOString();
    const execution = { agentId, assignedBy: callerUid, assignedAt: now, mode: visibility };
    await issueRef.update({ execution, updatedAt: now, updatedBy: callerUid });
    return { issueId, execution };
  }
}
