import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { agentVisibility, canDeleteAgent, getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';

const ACTIVE_JOB_STATUSES = new Set(['pending', 'delivered']);

/**
 * Removes an owned agent only while it has no audit trail or work in flight.
 * Agent runs and runner jobs are deliberately retained as immutable audit
 * records, so an agent that has used either cannot be deleted.
 */
export class DeleteAgentAction extends PlatformActionHandler {
  private agentId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.delete', request, callerUid, callerEmail);
    this.agentId = request.data?.agentId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.agentId) return false;
    const snap = await getFirestore().collection('agents').doc(this.agentId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const { agentId } = this.action.data;
    if (!agentId) throw new Error('Parámetro requerido faltante: agentId.');

    const agentRef = db.collection('agents').doc(agentId);
    const agentSnap = await agentRef.get();
    if (!agentSnap.exists) throw new Error(`El agente '${agentId}' no existe.`);
    const agent = agentSnap.data()!;
    const caller = await getWorkspaceMember(db, agent.workspaceId, this.caller.uid!);
    const callerIsAdmin = isWorkspaceAdmin(caller);

    if (!canDeleteAgent(agent, this.caller.uid!, callerIsAdmin)) {
      throw new Error(agentVisibility(agent) === 'public'
        ? 'Solo el admin que creó este agente público puede eliminarlo.'
        : 'Solo el dueño o un admin puede eliminar este agente personal.');
    }

    const [runsSnap, jobsSnap] = await Promise.all([
      db.collection('agent_runs').where('agentId', '==', agentId).limit(1).get(),
      db.collection('runner_jobs').where('agentId', '==', agentId).get(),
    ]);
    const activeJobs = jobsSnap.docs.filter((job) => ACTIVE_JOB_STATUSES.has(job.data().status));
    if (activeJobs.length > 0) {
      throw new Error('No se puede eliminar el agente porque tiene ejecuciones activas. Esperá a que terminen o expiren.');
    }
    if (!runsSnap.empty || !jobsSnap.empty) {
      throw new Error('No se puede eliminar el agente porque tiene actividad registrada. Conservamos el agente para mantener la auditoría.');
    }

    // Clear explicit execution and epic defaults so the deleted agent cannot
    // remain selected or be inherited by future child issues.
    const [assignedIssues, defaultAssignedIssues, keys] = await Promise.all([
      db.collection('issues').where('execution.agentId', '==', agentId).get(),
      db.collection('issues').where('defaultAssigneeId', '==', agentId).get(),
      db.collection('api_keys').where('agentId', '==', agentId).get(),
    ]);
    const issueUpdates = new Map<string, Record<string, unknown>>();
    const issueRefs = new Map<string, FirebaseFirestore.DocumentReference>();
    for (const issue of assignedIssues.docs) {
      issueRefs.set(issue.id, issue.ref);
      issueUpdates.set(issue.id, { ...(issueUpdates.get(issue.id) || {}), execution: null });
    }
    for (const issue of defaultAssignedIssues.docs) {
      issueRefs.set(issue.id, issue.ref);
      issueUpdates.set(issue.id, { ...(issueUpdates.get(issue.id) || {}), defaultAssigneeId: FieldValue.delete() });
    }
    const now = new Date().toISOString();
    const writes: Array<(batch: FirebaseFirestore.WriteBatch) => void> = [
      (batch) => {
        batch.delete(agentRef);
        batch.delete(db.collection('members').doc(`${agent.workspaceId}_${agentId}`));
      },
      ...Array.from(issueUpdates, ([issueId, fields]) => (batch: FirebaseFirestore.WriteBatch) =>
        batch.update(issueRefs.get(issueId)!, { ...fields, updatedAt: now, updatedBy: this.caller.uid })
      ),
      ...keys.docs
        .filter((key) => !key.data().revokedAt)
        .map((key) => (batch: FirebaseFirestore.WriteBatch) => batch.update(key.ref, { revokedAt: now })),
    ];

    while (writes.length) {
      const batch = db.batch();
      writes.splice(0, 500).forEach((write) => write(batch));
      await batch.commit();
    }

    return { agentId, deleted: true, clearedIssueAssignments: issueUpdates.size, revokedKeys: keys.docs.filter((key) => !key.data().revokedAt).length };
  }
}
