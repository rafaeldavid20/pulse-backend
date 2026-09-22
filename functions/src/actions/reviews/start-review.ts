import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { IssueReview } from '../../common/domain.generated';

const CLOSED_STATES = new Set(['approved', 'changes_requested', 'stale']);

/**
 * El backend de `pulse_next_review`: claim con lock, igual que
 * `issues.claimNext`, pero sobre la cola de revisión en vez de la de
 * trabajo. El issue a revisar ya lo eligió `qaDispatchTrigger` (D4) —
 * `review.dispatchedTo` — así que acá no hace falta elegir candidato por
 * prioridad, solo reclamar de forma atómica el que le corresponde a este
 * agente.
 *
 * `needs_human` nunca es candidato: ese estado es un pedido explícito de que
 * decida una persona, no algo que un QA deba volver a tomar.
 */
export class ReviewsStartAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('reviews.start', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const actorUid = this.caller.uid!;

    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    return db.runTransaction(async (tx: Transaction) => {
      const candidatesQuery = db
        .collection('issues')
        .where('workspaceId', '==', data.workspaceId)
        .where('status', '==', 'in_review');
      const snap = await tx.get(candidatesQuery);

      const candidates = snap.docs
        .map((d) => ({ ref: d.ref, issue: d.data() }))
        .filter(({ ref, issue }) => {
          // TES-276: con dos revisiones despachadas en paralelo al mismo agente,
          // sin esto cada run toma la primera que encuentra — y como una
          // revisión `running` de este mismo agente cuenta como "retomar", el
          // run de un issue terminaba revisando el del otro.
          if (data.issueId && ref.id !== data.issueId) return false;
          const review = issue.review as IssueReview | undefined;
          if (review?.dispatchedTo !== actorUid) return false;
          if (review.state === 'needs_human') return false;
          if (review.state === 'running' && review.claimedBy && review.claimedBy !== actorUid) return false;
          return true;
        })
        .sort((a, b) => {
          const da = a.issue.review?.dispatchedAt ? new Date(a.issue.review.dispatchedAt).getTime() : 0;
          const db2 = b.issue.review?.dispatchedAt ? new Date(b.issue.review.dispatchedAt).getTime() : 0;
          return da - db2;
        });

      if (candidates.length === 0) {
        return { found: false };
      }

      const { ref, issue } = candidates[0];
      const review = (issue.review as IssueReview | undefined) || undefined;
      const now = new Date().toISOString();

      const resumingSelf = review?.state === 'running' && review.claimedBy === actorUid;
      const startingNewAttempt = !review || CLOSED_STATES.has(review.state) || review.state === 'needs_human';

      let history = review?.history || [];
      let attempt = review?.attempt || 0;
      let startedAt = review?.startedAt || now;

      if (resumingSelf) {
        // No-op: keep attempt/startedAt from the in-progress claim.
      } else if (startingNewAttempt && review) {
        // Archive the previous closed attempt before opening a new one — the
        // top-level `review` is always the current attempt, `history` holds
        // everything closed before it (D3).
        const { history: _drop, claimedBy: _cb, claimedAt: _ca, previousAssigneeId: _pa, ...archived } = review;
        history = [...history, archived];
        attempt = (review.attempt || 0) + 1;
        startedAt = now;
      } else if (!review) {
        attempt = 1;
        startedAt = now;
      } else {
        // Pending, never claimed: first claim of the current attempt.
        attempt = review.attempt || 1;
      }

      const nextReview: IssueReview = {
        state: 'running',
        reviewerId: actorUid,
        attempt,
        startedAt,
        history,
        claimedBy: actorUid,
        claimedAt: now,
        // Un intento nuevo arranca sin los resultados del anterior — ya
        // archivados en `history` arriba.
        ...(startingNewAttempt && !resumingSelf
          ? {}
          : { verdict: review?.verdict, findings: review?.findings, criteriaResults: review?.criteriaResults, prs: review?.prs }),
      };

      tx.update(ref, {
        review: cleanUndefined(nextReview),
        updatedAt: now,
      });

      return {
        found: true,
        issue: { ...issue, id: ref.id, review: cleanUndefined(nextReview) },
        attempt,
        nextSteps: [
          `Llamar a pulse_get_review_context con '${issue.identifier}' para el diff, los criterios y el contexto completo.`,
          'Verificar cada criterio contra el diff, correr build/lint/tests si existen.',
          `Emitir el veredicto con pulse_submit_review sobre '${issue.identifier}'.`,
        ],
      };
    });
  }
}
