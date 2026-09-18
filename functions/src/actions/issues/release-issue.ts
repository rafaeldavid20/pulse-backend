import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class ReleaseIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.release', request, callerUid, callerEmail);
    this.issueId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.id) {
      throw new Error('Identificador de issue (id) es obligatorio para liberar.');
    }

    const issueRef = db.collection('issues').doc(data.id);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${data.id}' no existe.`);
    }

    const issue = snap.data()!;
    if (issue.agent?.claimedBy && issue.agent.claimedBy !== this.caller.uid) {
      throw new Error(`El issue está reclamado por '${issue.agent.claimedBy}', no por vos.`);
    }

    // Con un traspaso a otro repo todavía sin despachar (TES-202), soltar el
    // issue no puede desasignarlo ni devolverlo a `todo`: `agentDispatchTrigger`
    // necesita al agente asignado para despachar el run del repo destino, y el
    // issue sigue en curso. Sin traspaso pendiente, el comportamiento de
    // siempre.
    const hasPendingHandoff = (issue.pendingRepoWork || []).some((e: any) => !e.dispatchedAt);
    const nextStatus = hasPendingHandoff ? issue.status : issue.status === 'in_progress' ? 'todo' : issue.status;
    await issueRef.update({
      assigneeId: hasPendingHandoff ? issue.assigneeId ?? null : null,
      status: nextStatus,
      'agent.state': 'idle',
      'agent.claimedBy': FieldValue.delete(),
      // Un traspaso no es un bloqueo: no se marca `blockedReason` para no mostrarlo como tal.
      'agent.blockedReason': hasPendingHandoff ? FieldValue.delete() : data.reason ?? FieldValue.delete(),
      // Limpia la marca de idempotencia del dispatch (agent-dispatch.ts) para
      // que, si el issue vuelve a `todo` y se reasigna, el trigger no la
      // confunda con un dispatch reciente todavía en curso.
      'agent.dispatchedAt': FieldValue.delete(),
      'agent.dispatchedTo': FieldValue.delete(),
      updatedAt: new Date().toISOString(),
      updatedBy: this.caller.uid || 'system',
    });

    return { id: data.id, status: nextStatus };
  }
}
