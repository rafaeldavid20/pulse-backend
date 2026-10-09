import { Firestore, Transaction } from 'firebase-admin/firestore';
import type { McpPrincipal } from '../../mcp/auth';

/** Principal comes from MCP authentication, never from Platform Action data. */
export async function assertIssueDev(
  db: Firestore, transaction: Transaction, issueId: string,
  issue: FirebaseFirestore.DocumentData, actorUid: string, principal?: McpPrincipal,
): Promise<void> {
  const deny = () => { throw new Error('Solo el dev autorizado de este issue con una credencial vigente puede modificar su autoverificación o findings.'); };
  const agent = (await transaction.get(db.collection('agents').doc(actorUid))).data();
  if (agent && (agent.workspaceId !== issue.workspaceId || agent.role === 'qa' || agent.archivedAt)) deny();
  if (principal && (principal.workspaceId !== issue.workspaceId || (principal.agentId ?? principal.createdBy) !== actorUid)) deny();

  // A bound credential never falls back to legacy assignment when its job is stale.
  if (principal?.jobId) {
    if (principal.source !== 'api_key' || !principal.apiKeyId || !principal.runnerId ||
        principal.issueId !== issueId || principal.agentId !== actorUid || !agent) deny();
    const [keySnap, jobSnap, runnerSnap] = await Promise.all([
      transaction.get(db.collection('api_keys').doc(principal.apiKeyId!)),
      transaction.get(db.collection('runner_jobs').doc(principal.jobId)),
      transaction.get(db.collection('runners').doc(principal.runnerId!)),
    ]);
    const key = keySnap.data();
    const job = jobSnap.data();
    const runner = runnerSnap.data();
    const fresh = (expiresAt: unknown) => typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.now();
    if (!key || key.revokedAt || !fresh(key.expiresAt) ||
        !job || job.status !== 'delivered' || job.cancelRequestedAt || !fresh(job.expiresAt) ||
        !['task', 'rework'].includes(job.mode) || job.recoveryOf ||
        !runner || runner.revokedAt || runner.workspaceId !== issue.workspaceId) deny();
    for (const record of [key!, job!]) {
      if (record.workspaceId !== issue.workspaceId || record.issueId !== issueId ||
          record.agentId !== actorUid || record.runnerId !== principal.runnerId) deny();
    }
    if (key!.jobId !== principal.jobId || (issue.execution?.agentId || issue.assigneeId) !== actorUid) deny();
    return;
  }
  // Unbound API keys and callable requests retain the original assignment model.
  if (issue.assigneeId !== actorUid) deny();
}
