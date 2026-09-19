import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { DevCriterionCheck } from '../../common/domain.generated';

const RESULTS: DevCriterionCheck['result'][] = ['met', 'not_met', 'unverifiable'];

function normalizeChecks(input: unknown): DevCriterionCheck[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof c.criterionId === 'string' && c.criterionId)
    .map((c) => {
      const result = c.result as DevCriterionCheck['result'];
      if (!RESULTS.includes(result)) {
        throw new Error(`Resultado de autoverificación inválido: '${String(c.result)}'. Debe ser uno de: ${RESULTS.join(', ')}.`);
      }
      const evidence = typeof c.evidence === 'string' ? c.evidence.trim() : '';
      if (!evidence) {
        throw new Error(`El criterio '${c.criterionId as string}' necesita evidencia (archivo, comando corrido, o salida).`);
      }
      return { criterionId: c.criterionId as string, result, evidence };
    });
}

/**
 * `reviews.reportCriteria` (D5, para la autoverificación del dev de D13): el
 * dev asignado declara, criterio por criterio, si cumplió la rúbrica antes de
 * abrir el PR. Reemplazo completo (como `acceptanceCriteria` en
 * `issues.update`) — no un upsert — para que un run que corrige su propia
 * autoverificación no deje entradas viejas colgando.
 *
 * El QA la recibe en `pulse_get_review_context` como dato a contrastar contra
 * el diff, nunca como una verdad ya confirmada.
 */
export class ReportCriteriaAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.reportCriteria', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
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
    const actorUid = this.caller.uid!;

    if (!data.issueId) {
      throw new Error('Parámetro requerido faltante: issueId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    const issue = issueSnap.data()!;

    if (issue.assigneeId !== actorUid) {
      throw new Error('Solo el dev asignado a este issue puede reportar su autoverificación.');
    }

    const checks = normalizeChecks(data.checks);

    await issueRef.update(
      cleanUndefined({
        devSelfCheck: checks,
        updatedAt: new Date().toISOString(),
        updatedBy: actorUid,
      })
    );

    return { issueId: data.issueId, devSelfCheck: checks };
  }
}
