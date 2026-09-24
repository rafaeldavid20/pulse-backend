import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentAllowedRepos, agentVisibility, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';
import { enqueueRunnerJob } from '../../common/utils/runner-jobs';
import { mcpKeyPepper } from '../../common/secrets';
import { generateApiKey, hashApiKeySecret } from '../../common/utils/api-key';
import { DEV_SCOPES, QA_SCOPES } from '../../mcp/scopes';

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
    if (runner.status !== 'online') throw new Error('El Runner debe estar online para recibir un job.');
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
    // La key sólo vive lo mismo que el job y lleva su scope de identidad para
    // que el servidor pueda revocarla/atribuirla incluso si el Runner cae.
    const { keyId, secret, fullKey, prefix } = generateApiKey();
    await db.collection('api_keys').doc(keyId).set({
      id: keyId,
      workspaceId: issue.workspaceId,
      name: `Runner job ${job.id}`,
      hash: hashApiKeySecret(secret, mcpKeyPepper.value()),
      prefix,
      scopes: agent.role === 'qa' ? QA_SCOPES : DEV_SCOPES,
      agentId,
      createdBy: this.caller.uid,
      jobId: job.id,
      issueId: issue.id,
      runnerId: agent.runnerId,
      repoFullName,
      expiresAt: job.expiresAt,
      createdAt: job.issuedAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    return { job, mcpCredential: fullKey };
  }

  protected auditResponse(response: Record<string, any>): Record<string, any> {
    const { mcpCredential: _secret, ...safe } = response;
    return safe;
  }
}
