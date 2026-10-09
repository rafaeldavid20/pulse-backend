import type { McpPrincipal } from '../../mcp/auth';
import { assertIssueDev } from './dev-authorization';
import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { IssueReview } from '../../common/domain.generated';

const RESOLUTIONS = ['fixed', 'disputed'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

/**
 * `reviews.resolveFinding` (D5, para el re-trabajo de D9): el dev autorizado
 * responde un finding del intento de revisión en curso. `fixed` lo marca
 * resuelto tras pushear una corrección; `disputed` pide que el QA del
 * siguiente intento lo reconsidere en vez de darlo por bueno sin más.
 */
export class ResolveFindingAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string, private readonly principal?: McpPrincipal) {
    super('reviews.resolveFinding', request, callerUid, callerEmail);
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

    const resolution = data.resolution as Resolution;
    if (!data.issueId || !data.findingId || !RESOLUTIONS.includes(resolution)) {
      throw new Error(`Parámetros requeridos: issueId, findingId, resolution (uno de: ${RESOLUTIONS.join(', ')}).`);
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    return db.runTransaction(async (transaction) => {
      const issueSnap = await transaction.get(issueRef);
      if (!issueSnap.exists) throw new Error(`El issue con ID '${data.issueId}' no existe.`);
      const issue = issueSnap.data()!;

      await assertIssueDev(db, transaction, data.issueId, issue, actorUid, this.principal);

      const review = issue.review as IssueReview | undefined;
      const findings = review?.findings || [];
      const idx = findings.findIndex((f) => f.id === data.findingId);
      if (idx === -1) {
        throw new Error(`No se encontró el finding '${data.findingId}' en el intento de revisión actual.`);
      }

      const nextFindings = [...findings];
      nextFindings[idx] = {
        ...nextFindings[idx],
        status: resolution,
        resolutionNote: data.note ? String(data.note).trim() : undefined,
      };

      transaction.update(issueRef, {
        review: cleanUndefined({ ...review, findings: nextFindings }),
        updatedAt: new Date().toISOString(),
        updatedBy: actorUid,
      });

      return { issueId: data.issueId, findingId: data.findingId, status: resolution };
    });
  }
}
