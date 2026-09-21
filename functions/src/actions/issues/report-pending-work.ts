import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { normalizeReason, registerPendingWork } from '../../common/utils/pending-work';

/**
 * `issues.reportPendingWork` (TES-219): el agente declara trabajo que no pudo
 * hacer y que **ningún run va a poder hacer** — una migración contra
 * producción, una decisión de producto, algo que se fue del alcance.
 *
 * Es el caso hermano de `issues.requestRepoWork`: allá el trabajo lo retoma
 * otro run en otro repo, así que alcanza con anotarlo y despacharlo; acá no hay
 * run que lo tome, así que el servidor crea el issue de seguimiento en el acto.
 * La diferencia importa: lo que se escribía en el cuerpo del PR desaparecía con
 * el merge (TES-218), y un campo del que nadie deriva un issue tampoco se
 * habría leído.
 *
 * Esta action no cambia el status del issue. Lo que sostiene la invariante es
 * `github.syncFromWebhook`, que no cierra un issue con un criterio `not_met`
 * sin follow-up ni con un pendiente que no llegó a materializarse.
 */
export class ReportPendingWorkAction extends PlatformActionHandler {
  private issueId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.reportPendingWork', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    return this.isWorkspaceMember(snap.data()!.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.issueId || !data.summary) {
      throw new Error('Parámetros requeridos faltantes: issueId, summary.');
    }

    const snap = await db.collection('issues').doc(data.issueId).get();
    if (!snap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = snap.data()!;

    // Un `criterionId` que no existe en la rúbrica es casi siempre un id
    // inventado por el modelo: se rechaza acá en vez de guardar un pendiente
    // que apunta a la nada y que el gate de cierre nunca va a poder casar.
    if (data.criterionId && !(issue.acceptanceCriteria || []).some((c: any) => c?.id === data.criterionId)) {
      const ids = (issue.acceptanceCriteria || []).map((c: any) => c.id).join(', ') || 'ninguno';
      throw new Error(`El criterio '${data.criterionId}' no existe en ${issue.identifier}. Criterios: ${ids}.`);
    }

    const { entry, pendingWork, created } = await registerPendingWork(db, {
      issueId: data.issueId,
      issue,
      summary: String(data.summary),
      reason: normalizeReason(data.reason),
      context: data.context ? String(data.context) : undefined,
      criterionId: data.criterionId ? String(data.criterionId) : undefined,
      source: 'dev',
      actorUid: this.caller.uid || 'system',
    });

    return {
      issueId: data.issueId,
      entry,
      pendingWork,
      followUpCreated: created,
      followUpIdentifier: entry.followUpIdentifier,
    };
  }
}
