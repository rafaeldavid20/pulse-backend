import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentAllowedRepos, agentVisibility, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';
import { enqueueRunnerJob } from '../../common/utils/runner-jobs';
import { mcpKeyPepper } from '../../common/secrets';
import { isRunnerAvailable } from '../../common/utils/runner-availability';

async function assertRunnerCapacity(db: FirebaseFirestore.Firestore, runnerId: string, maxConcurrentJobs: number) {
  const active = await db.collection('runner_jobs').where('runnerId', '==', runnerId).get();
  const count = active.docs.filter((snap) => ['pending', 'delivered'].includes(snap.data().status) && new Date(snap.data().expiresAt).getTime() > Date.now()).length;
  if (count >= maxConcurrentJobs) throw new Error('El Runner ya alcanzó su capacidad de jobs activos.');
}

/** Human-authorized fallback to enqueue a signed local Runner job. */
export class IssueRunnerJobAction extends PlatformActionHandler {
  private issueId?: string;
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.issueJob', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId!).get();
    if (!snap.exists) return false;
    this.workspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const issueSnap = await db.collection('issues').doc(this.issueId!).get();
    const issue = issueSnap.data()!;
    const agentId = issue.execution?.agentId;
    if (!agentId) throw new Error('El issue no tiene un agente ejecutor seleccionado.');
    const agentSnap = await db.collection('agents').doc(agentId).get();
    if (!agentSnap.exists) throw new Error('El agente ejecutor ya no existe.');
    const agent = agentSnap.data()!;
    const caller = await getWorkspaceMember(db, issue.workspaceId, this.caller.uid!);
    if (agentVisibility(agent) === 'public') {
      if (!isWorkspaceAdmin(caller)) throw new Error('Solo un admin puede emitir jobs para agentes públicos.');
    } else if (agent.ownerMemberId !== this.caller.uid || issue.responsibleMemberId !== this.caller.uid) {
      throw new Error('Solo el dueño puede emitir un job de su agente personal en sus propios issues.');
    }
    if (!agent.runnerId) throw new Error('El agente no tiene un Pulse Runner vinculado.');
    const runnerSnap = await db.collection('runners').doc(agent.runnerId).get();
    if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== issue.workspaceId) throw new Error('El Runner del agente no existe en este workspace.');
    const runner = runnerSnap.data()!;
    if (!isRunnerAvailable(runner)) throw new Error('El Runner debe estar online y con un heartbeat reciente para recibir un job.');
    await assertRunnerCapacity(db, agent.runnerId, runner.maxConcurrentJobs || 1);
    const repoFullName = this.action.data.repoFullName;
    if (typeof repoFullName !== 'string' || !repoFullName) throw new Error('repoFullName es obligatorio.');
    if (!runner.connectedRepos.includes(repoFullName) || !agentAllowedRepos(agent).includes(repoFullName)) {
      throw new Error('El repo no está autorizado para este agente y Runner.');
    }
    const job = await enqueueRunnerJob(db, {
      workspaceId: issue.workspaceId,
      issueId: issue.id,
      agentId,
      runnerId: agent.runnerId,
      repoFullName,
      mode: 'task',
    }, mcpKeyPepper.value());
    // La credencial MCP se crea al entregar el job al Runner autenticado,
    // nunca se devuelve al navegador que lo emitió.
    return { job };
  }
}

/** Re-emits a terminal job without widening its issue, repo, agent, or Runner scope. */
export class RetryRunnerJobAction extends PlatformActionHandler {
  private jobId?: string;
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.retryJob', request, callerUid, callerEmail);
    this.jobId = request.data?.jobId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.jobId) return false;
    const job = await getFirestore().collection('runner_jobs').doc(this.jobId).get();
    if (!job.exists) return false;
    this.workspaceId = job.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const originalSnap = await db.collection('runner_jobs').doc(this.jobId!).get();
    const original = originalSnap.data()!;
    if (!['failed', 'canceled', 'expired'].includes(original.status)) throw new Error('Sólo se pueden reintentar jobs fallidos, cancelados o expirados.');
    if (original.retriedByJobId) throw new Error('Este job ya fue reintentado.');
    const [runnerSnap, agentSnap, issueSnap, caller] = await Promise.all([
      db.collection('runners').doc(original.runnerId).get(),
      db.collection('agents').doc(original.agentId).get(),
      db.collection('issues').doc(original.issueId).get(),
      getWorkspaceMember(db, original.workspaceId, this.caller.uid!),
    ]);
    if (!runnerSnap.exists) throw new Error('El Runner original ya no existe.');
    if (!agentSnap.exists || !issueSnap.exists) throw new Error('El agente o issue original ya no existe.');
    const runner = runnerSnap.data()!;
    const agent = agentSnap.data()!;
    const issue = issueSnap.data()!;
    if (!isRunnerAvailable(runner)) throw new Error('El Runner debe estar online, no revocado y con un heartbeat reciente para reintentar.');
    if (runner.ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(caller)) throw new Error('Sólo el dueño del Runner o un admin puede reintentar este job.');
    if (!agent.enabled || agent.workspaceId !== original.workspaceId || agent.runnerId !== runner.id || !agentAllowedRepos(agent).includes(original.repoFullName)) {
      throw new Error('El agente ya no está habilitado para este Runner o repo.');
    }
    if (agentVisibility(agent) === 'public') {
      if (!isWorkspaceAdmin(caller)) throw new Error('Sólo un admin puede reintentar jobs de agentes públicos.');
    } else if (agent.ownerMemberId !== this.caller.uid || issue.responsibleMemberId !== this.caller.uid) {
      throw new Error('Sólo el dueño puede reintentar su agente personal en su propio issue.');
    }
    if (!runner.connectedRepos.includes(original.repoFullName)) throw new Error('El repo ya no está conectado a este Runner.');
    await assertRunnerCapacity(db, original.runnerId, runner.maxConcurrentJobs || 1);
    const job = await enqueueRunnerJob(db, {
      workspaceId: original.workspaceId, issueId: original.issueId, agentId: original.agentId,
      runnerId: original.runnerId, repoFullName: original.repoFullName, mode: original.mode,
    }, mcpKeyPepper.value());
    await Promise.all([
      db.collection('runner_jobs').doc(job.id).update({ retryOf: original.id }),
      originalSnap.ref.update({ retriedByJobId: job.id, retryRequestedAt: new Date().toISOString() }),
    ]);
    return { job: { ...job, retryOf: original.id } };
  }
}
