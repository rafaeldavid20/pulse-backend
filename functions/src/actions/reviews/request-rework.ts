import { createHash } from 'crypto';
import { activityLease } from '../../common/utils/run-activity';
import { checkWorkspaceDispatchBudget } from '../../common/utils/dispatch-counter';
import { activeDevelopmentJob, developmentState, hasExecutionLease } from '../../common/utils/development-execution';
import { runnerPreflight } from '../../common/utils/runner-preflight';
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

/** Human development and rework share the signed queue; automatic mode and QA policy are preserved. */
export class RequestReworkAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string, code: 'reviews.requestRework' | 'issues.requestDevelopment' | 'issues.developmentStatus' = 'reviews.requestRework') {
    super(code, request, callerUid, callerEmail);
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
    const { issueId, requestId } = this.action.data;
    const statusOnly = this.actionCode === 'issues.developmentStatus';
    if (!statusOnly && (requestId !== undefined || this.actionCode === 'issues.requestDevelopment') && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))) throw new Error('La solicitud necesita un identificador válido para poder reintentar sin duplicar el trabajo.');
    const comment = this.action.data.comment ?? (this.actionCode === 'reviews.requestRework' ? '' : 'Corregí los findings abiertos del intento vigente de QA y continuá los mismos PRs.');
    if (typeof comment !== 'string' || !comment.trim() || comment.length > 4000) {
      throw new Error('Escribí un comentario para el agente (máximo 4000 caracteres).');
    }
    const issue = (await db.collection('issues').doc(issueId).get()).data()!;
    const mode = issue.review?.state === 'changes_requested' ? 'rework' : 'task';
    const [jobs, runs] = await Promise.all([
      db.collection('runner_jobs').where('issueId', '==', issueId).get(),
      db.collection('agent_runs').where('issueId', '==', issueId).get(),
    ]);
    const state = developmentState(issue, jobs.docs.map(s => s.data()), runs.docs.map(s => s.data()));
    try {
      const agentId = issue.execution?.agentId || issue.assigneeId;
      if (!agentId) throw new Error('Elegí un agente ejecutor habilitado en el detalle del issue.');
      const agent = (await db.collection('agents').doc(agentId).get()).data();
      if (!agent || agent.workspaceId !== issue.workspaceId || agent.role !== 'dev' || !agent.enabled || agent.archivedAt || !agent.runnerId) {
        throw new Error('Elegí un agente dev habilitado con Pulse Runner. Revisá su configuración en Ajustes de agentes.');
      }
      const callerUid = this.caller.uid!;
      assertHumanReworkRequester(callerUid, await getWorkspaceMember(db, issue.workspaceId, callerUid), agent, issue);
      if (!statusOnly && requestId) {
        const key = createHash('sha256').update(`${issueId}:${callerUid}:${requestId}`).digest('hex');
        const receipt = await db.collection('development_requests').doc(key).get();
        if (receipt.exists) return { issueId, jobId: receipt.data()!.jobId, mode: receipt.data()!.mode, replayed: true };
      }
      if (!['todo', 'in_progress', 'in_review'].includes(issue.status)) throw new Error('Reabrí el issue y pasalo a Por hacer antes de ejecutar desarrollo.');
      if (state.active) throw new Error('Hay un job en cola o una ejecución viva. Esperá a que termine; consultá el diagnóstico del Runner.');
      if ((issue.pendingRepoWork || []).some((entry: any) => !entry.dispatchedAt)) throw new Error('El issue tiene un traspaso pendiente; esperá a que termine.');
      if (mode === 'task' && (issue.review?.state || issue.status === 'in_review' || (issue.gitRefs || [issue.git]).some((ref: any) => ref?.prNumber))) throw new Error('Resolvé la revisión o el PR existente antes de iniciar desarrollo. Para una revisión escalada, usá Devolver al agente.');
      if (this.actionCode === 'reviews.requestRework' && mode !== 'rework') throw new Error('Solo se puede solicitar una corrección cuando QA pidió cambios.');
      const qaId = issue.review?.reviewerId || issue.review?.dispatchedTo;
      const qa = qaId ? (await db.collection('agents').doc(qaId).get()).data() : undefined;
      const attempt = issue.review?.attempt;
      if (mode === 'rework' && (!Number.isInteger(attempt) || attempt < 1 || attempt >= (qa?.maxReviewAttempts ?? 2))) {
        throw new Error('No quedan intentos de revisión disponibles; usá la recuperación de una revisión escalada.');
      }
      const budget = await checkIssueRunBudget(db, issue.workspaceId, issueId);
      if (!budget.withinBudget) throw new Error('El issue alcanzó su límite de ejecuciones o costo; la solicitud no reinicia esos límites.');
      const installations = await db.collection('github_installations').where('workspaceId', '==', issue.workspaceId).get();
      const authorized: string[] = installations.docs.flatMap((doc) => doc.data().suspendedAt ? [] : doc.data().repositoryFullNames || []);
      const access = await runnerProjectRepoAccess(db, issue, authorized);
      if (!access) throw new Error('Configurá los repositorios autorizados del proyecto antes de solicitar una corrección.');
      const { repoFullName } = await resolveIssueRepo(db, { ...issue, id: issueId }, { agentId });
      const flaggedRepo = issue.review?.findings?.find((finding: any) => finding.status === 'open' && ['major', 'blocker'].includes(finding.severity) && finding.repoFullName)?.repoFullName;
      const target = flaggedRepo || repoFullName;
      if (!target) throw new Error('No se pudo resolver el repositorio a corregir.');
      const contextRepos = mode === 'rework' ? reworkRepositories(issue, access.repos, target) : access.repos;
      if (!access.repos.includes(target)) throw new Error('Elegí un repositorio destino autorizado por el proyecto y GitHub.');
      const runner = (await db.collection('runners').doc(agent.runnerId).get()).data();
      const preflight = runnerPreflight({ ...agent, id: agentId }, runner ? { ...runner, id: agent.runnerId } : null, issue.workspaceId, contextRepos, mode, Date.now(), true);
      if (runner?.readiness?.jobProtocolVersion === 3 && contextRepos.some(repo => !runner.readiness.githubApps?.some((binding: any) => binding.projectId === access.projectId && binding.repo === repo && binding.ready))) throw new Error('Configurá y verificá una GitHub App local para cada repositorio del trabajo en el Runner.');
      if (!preflight.ready) throw new Error(preflight.problems.map(p => `${p.message} ${p.action}`).join(' '));
      if (statusOnly) {
        const preview = await db.runTransaction(tx => checkWorkspaceDispatchBudget(tx, db, issue.workspaceId, false));
        if (!preview.allowed) throw new Error(preview.reason === 'paused' ? 'Los agentes están pausados. Reanudalos en Ajustes de agentes.' : 'Se alcanzó el límite diario de ejecuciones o costo. Revisá los límites con un administrador en Ajustes de agentes.');
        const agentJobs = await db.collection('runner_jobs').where('agentId', '==', agentId).get();
        const others = new Set(agentJobs.docs.filter(s => s.data().issueId !== issueId && activeDevelopmentJob(s.data())).map(s => s.data().issueId));
        const agentRuns = await db.collection('agent_runs').where('agentId', '==', agentId).get();
        for (const snap of agentRuns.docs) if (snap.data().issueId !== issueId && activityLease(snap.data())) others.add(snap.data().issueId);
        const agentIssues = await db.collection('issues').where('workspaceId', '==', issue.workspaceId).get();
        for (const snap of agentIssues.docs) if (snap.id !== issueId && (snap.data().execution?.agentId || snap.data().assigneeId) === agentId && hasExecutionLease(snap.data(), [])) others.add(snap.id);
        if (others.size >= (agent.maxConcurrentIssues ?? 1)) throw new Error('El agente alcanzó su capacidad de issues activos. Esperá a que termine otra ejecución.');
        const runnerJobs = await db.collection('runner_jobs').where('runnerId', '==', agent.runnerId).get();
        if (runnerJobs.docs.filter(s => activeDevelopmentJob(s.data())).length >= (runner!.maxConcurrentJobs || 1)) throw new Error('El Runner alcanzó su capacidad de jobs activos. Esperá a que termine otro job.');
        return { ...state, mode, available: true };
      }
      const job = await enqueueRunnerJob(db, {
        workspaceId: issue.workspaceId, projectId: access.projectId, issueId, agentId,
        runnerId: agent.runnerId, repoFullName: target, contextRepos, mode,
      }, runnerJobSigningPrivateKey.value(), 'runner-job-v1', mode === 'rework' ? { mode, attempt, requestedBy: callerUid, comment: comment.trim(), ...(requestId ? { requestId } : {}) } : { mode, requestedBy: callerUid, requestId });
      return { issueId, jobId: job.id, mode };
    } catch (error) {
      if (!statusOnly) throw error;
      return { ...state, mode, available: false, reason: error instanceof Error ? error.message : 'No se pudo verificar la disponibilidad.' };
    }
  }
}
