import { runnerPreflight } from '../../common/utils/runner-preflight';
import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { IssueReview } from '../../common/domain.generated';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import { getWorkspaceMember } from '../../common/utils/agent-authorization';
import { reviewRequestRefs } from '../../common/utils/review-request';
import { getPullRequestOrigin } from '../../github/client';
import { enqueueRunnerJob } from '../../common/utils/runner-jobs';
import { isRunnerAvailable } from '../../common/utils/runner-availability';
import { runnerJobSigningPrivateKey } from '../../common/secrets';
import { qaAssignmentError } from '../../common/utils/qa-assignment';
import { findProjectQaRunner } from '../../common/utils/qa-runner';

/** Explicit human QA request: one transactional job, with no reset of automatic limits. */
export class ReviewsRerunAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.rerun', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    if (!this.caller.uid) return false;
    const db = getFirestore();
    const member = await getWorkspaceMember(db, this.resolvedWorkspaceId!, this.caller.uid);
    const agent = await db.collection('agents').doc(this.caller.uid).get();
    return !!member && !member.isAgent && !agent.exists;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.issueId) {
      throw new Error('Parámetro requerido faltante: issueId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    if (!['in_review', 'in_progress', 'todo'].includes(issue.status)) throw new Error('Solo se puede solicitar QA en una issue activa con PRs elegibles.');
    const review = issue.review as IssueReview | undefined;
    if (review?.state === 'running') throw new Error('QA sigue activo. Esperá a que termine antes de solicitar otra revisión.');
    const refs = reviewRequestRefs(issue);
    const prs: Array<{repoFullName: string; prNumber: number; branch?: string}> = issue.gitRefs?.length ? issue.gitRefs : [issue.git];

    const { repoFullName } = await resolveIssueRepo(db, { ...issue, id: data.issueId }, { agentId: issue.execution?.agentId || issue.assigneeId });
    if (!repoFullName) {
      throw new Error(`No se pudo resolver el repo del issue '${issue.identifier}'.`);
    }

    const qaSnap = await db
      .collection('agents')
      .where('workspaceId', '==', issue.workspaceId)
      .where('role', '==', 'qa')
      .where('enabled', '==', true)
      .get();
    const assignedQa = issue.qaAssigneeId ? qaSnap.docs.find((d) => d.id === issue.qaAssigneeId) : undefined;
    if (issue.qaAssigneeId && !assignedQa) {
      throw new Error('El agente QA asignado ya no está habilitado o no pertenece a este workspace.');
    }
    const executionAgentId = issue.execution?.agentId || issue.assigneeId;
    if (assignedQa) {
      const assignmentError = qaAssignmentError(assignedQa.id, assignedQa.data(), issue.workspaceId, executionAgentId, repoFullName);
      if (assignmentError) throw new Error(assignmentError);
    }
    const qaCandidates = assignedQa
      ? [assignedQa]
      : qaSnap.docs.filter((d) => d.data().autonomousMode === true && d.id !== executionAgentId && !d.data().archivedAt && !!d.data().runnerId);
    if (qaCandidates.length === 0) {
      throw new Error(`No hay un agente QA habilitado con Pulse Runner para revisar '${repoFullName}' para re-ejecutar la revisión.`);
    }
    const reviewRepos = [...new Set(prs.map((pr) => pr.repoFullName))];
    let qaDoc: (typeof qaSnap.docs)[number] | undefined;
    let runner: FirebaseFirestore.DocumentData | undefined;
    const runnerCandidates = qaCandidates.filter((item) => !!item.data().runnerId);
    let runnerProblems: string[] = [];
    for (const candidate of runnerCandidates) {
      const result = await findProjectQaRunner(db, { ...candidate.data(), id: candidate.id }, issue.workspaceId, reviewRepos);
      if (!result.runner) { runnerProblems = result.problems; continue; }
      qaDoc = candidate;
      runner = result.runner;
      break;
    }
    if (qaDoc?.data().runnerId && !runner) {
      throw new Error(runnerProblems.join(' ') || 'No hay un Pulse Runner activo con la identidad QA configurada.');
    }
    // QA requiere un Runner disponible; no existe transporte alternativo.
    if (!qaDoc && runnerCandidates.length > 0) throw new Error(`El QA Runner del proyecto no está disponible para revisar '${repoFullName}'. ${runnerProblems.join(' ') || 'Revisá su identidad, sesión y conexión.'} No se enviará el issue a GitHub Actions.`);
    if (!qaDoc) throw new Error(`No hay un agente QA con Runner disponible para re-ejecutar la revisión de '${repoFullName}'.`);
    const qaAgent = qaDoc.data();
    const qaAgentId = qaDoc.id;
    const runnerId = runner?.id || (qaAgent.runnerId as string | undefined);
    if (!runnerId || !runner) throw new Error('Vinculá un Pulse Runner local al agente QA. Los agentes de GitHub Actions fueron retirados.');
    if (runnerId) {
      const runnerSnap = await db.collection('runners').doc(runnerId).get();
      if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== issue.workspaceId || !isRunnerAvailable(runnerSnap.data()!)) throw new Error('El Pulse Runner del agente QA dejó de estar disponible o ya no cubre todos los repos.');
      runner = runnerSnap.data()!;
      const preflight = runnerPreflight({ ...qaAgent, id: qaAgentId, runnerId }, { ...runner, id: runnerId }, issue.workspaceId, reviewRepos, 'review', Date.now(), true);
      if (!preflight.ready) throw new Error(preflight.problems.map((problem) => `${problem.message} ${problem.action}`).join(' '));
      const jobs = await db.collection('runner_jobs').where('runnerId', '==', runnerId).get();
      const active = jobs.docs.filter((doc) => {
        const job = doc.data();
        if (!['pending', 'delivered'].includes(job.status)) return false;
        const expiresAt = new Date(job.expiresAt).getTime();
        return !Number.isFinite(expiresAt) || expiresAt > Date.now();
      }).length;
      if (active >= (runner.maxConcurrentJobs || 1)) throw new Error('El Pulse Runner QA ya alcanzó su límite de jobs activos.');
      if (qaAgent.runnerId !== runnerId) {
        await db.collection('agents').doc(qaAgentId).update({ runnerId, updatedAt: new Date().toISOString() });
        qaAgent.runnerId = runnerId;
      }
    }

    const nextAttempt = (review?.attempt || 0) + 1;

    const installSnap = await db.collection('github_installations').where('workspaceId', '==', issue.workspaceId).limit(1).get();
    if (installSnap.empty) {
      throw new Error(`El workspace '${issue.workspaceId}' no tiene una instalación de GitHub conectada.`);
    }
    const installation = installSnap.docs[0].data();
    const authorized: string[] = installation.repositoryFullNames || [];
    if (!authorized.includes(repoFullName) || prs.some(pr => !authorized.includes(pr.repoFullName))) {
      throw new Error(`'${repoFullName}' no está autorizado en la instalación de GitHub de este workspace.`);
    }

    let origins;
    try {
      origins = await Promise.all(prs.map(pr => getPullRequestOrigin(installation.installationId, pr.repoFullName, pr.prNumber)));
    } catch {
      throw new Error('No se pudieron verificar los PRs en GitHub. Revisá la conexión del workspace y reintentá.');
    }
    if (prs.some((pr, i) => origins[i].headRepoFullName !== pr.repoFullName || (pr.branch && origins[i].headRef !== pr.branch))) throw new Error('Los PRs deben provenir de las ramas registradas en sus repositorios. Revisá los PRs vinculados.');
    const job = await enqueueRunnerJob(db, {
      workspaceId: issue.workspaceId, issueId: data.issueId, agentId: qaAgentId,
      runnerId, repoFullName,
      contextRepos: (await db.collection('projects').doc(issue.projectId).get()).data()?.repoFullNames || [],
      mode: 'review',
    }, runnerJobSigningPrivateKey.value(), 'runner-job-v1', {
      mode: 'review', attempt: review?.attempt || 0, refs, requestedBy: this.caller.uid!,
    });
    return { issueId: data.issueId, jobId: job.id, repoFullName, qaAgentId, attempt: nextAttempt, requestSource: 'manual' };
  }
}
