import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { getWorkspaceMember } from '../../common/utils/agent-authorization';
import { assertHumanReworkRequester, reworkRepositories } from '../../common/utils/human-rework';
import { checkIssueRunBudget } from '../../common/utils/issue-run-budget';
import { runnerProjectRepoAccess } from '../../common/utils/project-repos';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import { enqueueRunnerJob } from '../../common/utils/runner-jobs';
import { runnerJobSigningPrivateKey } from '../../common/secrets';

/** Explicit human rework, including shadow QA, without changing QA mode or resetting limits. */
export class RequestReworkAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.requestRework', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    if (!this.caller.uid || !this.action.data.issueId) return false;
    const db = getFirestore();
    const issue = await db.collection('issues').doc(this.action.data.issueId).get();
    if (!issue.exists) return false;
    const [member, agent] = await Promise.all([
      getWorkspaceMember(db, issue.data()!.workspaceId, this.caller.uid),
      db.collection('agents').doc(this.caller.uid).get(),
    ]);
    return !!member && member.isAgent !== true && !agent.exists;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const { issueId, comment } = this.action.data;
    if (typeof comment !== 'string' || !comment.trim() || comment.length > 4000) {
      throw new Error('Escribí un comentario para el agente (máximo 4000 caracteres).');
    }
    const issue = (await db.collection('issues').doc(issueId).get()).data()!;
    if (issue.review?.state !== 'changes_requested' || !['in_review', 'in_progress', 'todo'].includes(issue.status)) {
      throw new Error('Solo se puede solicitar una corrección cuando QA pidió cambios en un issue activo.');
    }
    if ((issue.pendingRepoWork || []).some((entry: any) => !entry.dispatchedAt)) throw new Error('El issue tiene un traspaso pendiente; esperá a que termine antes de solicitar una corrección.');
    const agentId = issue.execution?.agentId || issue.assigneeId;
    if (!agentId) throw new Error('Asigná un agente dev antes de solicitar la corrección.');
    const agent = (await db.collection('agents').doc(agentId).get()).data();
    if (!agent || agent.workspaceId !== issue.workspaceId || agent.role !== 'dev' || !agent.enabled || agent.archivedAt || !agent.runnerId) {
      throw new Error('El agente dev debe estar habilitado y tener un Pulse Runner vinculado.');
    }
    const callerUid = this.caller.uid!;
    assertHumanReworkRequester(callerUid, await getWorkspaceMember(db, issue.workspaceId, callerUid), agent, issue);
    const qaId = issue.review.reviewerId || issue.review.dispatchedTo;
    const qa = qaId ? (await db.collection('agents').doc(qaId).get()).data() : undefined;
    const attempt = issue.review.attempt;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt >= (qa?.maxReviewAttempts ?? 2)) {
      throw new Error('No quedan intentos de revisión disponibles; usá la recuperación de una revisión escalada.');
    }
    const budget = await checkIssueRunBudget(db, issue.workspaceId, issueId);
    if (!budget.withinBudget) throw new Error('El issue alcanzó su límite de ejecuciones o costo; la solicitud no reinicia esos límites.');
    const installations = await db.collection('github_installations').where('workspaceId', '==', issue.workspaceId).get();
    const authorized: string[] = installations.docs.flatMap((doc) => doc.data().suspendedAt ? [] : doc.data().repositoryFullNames || []);
    const access = await runnerProjectRepoAccess(db, issue, authorized);
    if (!access) throw new Error('Configurá los repositorios autorizados del proyecto antes de solicitar una corrección.');
    const { repoFullName } = await resolveIssueRepo(db, { ...issue, id: issueId }, { agentId });
    const flaggedRepo = issue.review.findings?.find((finding: any) => finding.status === 'open' && ['major', 'blocker'].includes(finding.severity) && finding.repoFullName)?.repoFullName;
    const target = flaggedRepo || repoFullName;
    if (!target) throw new Error('No se pudo resolver el repositorio a corregir.');
    const contextRepos = reworkRepositories(issue, access.repos, target);
    const job = await enqueueRunnerJob(db, {
      workspaceId: issue.workspaceId, projectId: access.projectId, issueId, agentId,
      runnerId: agent.runnerId, repoFullName: target, contextRepos, mode: 'rework',
    }, runnerJobSigningPrivateKey.value(), 'runner-job-v1', { mode: 'rework', attempt, requestedBy: callerUid, comment: comment.trim() });
    return { issueId, jobId: job.id, mode: 'rework' };
  }
}
