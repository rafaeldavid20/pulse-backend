import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { cleanUndefined } from '../common/utils/clean';
import { resolveReviewLead, ensureNeedsHumanLabel, notifyNeedsHuman } from '../common/utils/review-escalation';
import { IssueReview } from '../common/domain.generated';

const STUCK_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * D6: barrido de revisiones colgadas, red de contención detrás de
 * `pulse_report_review_incomplete` (que solo dispara si el run de QA llega a
 * arrancar y a reportar). Cubre lo que ese llamado no puede: un
 * `repository_dispatch` que nunca hizo arrancar el job en GitHub, un runner
 * que se cae sin ejecutar el paso de reporte, o cualquier otro cuelgue que no
 * pase por Claude Code.
 *
 * Corre cada 10 minutos y escala a `needs_human` cualquier `review.state ===
 * 'running'` cuyo `startedAt` tenga más de 30 minutos — bien por encima del
 * timeout duro del job (`timeout-minutes` en pulse-qa.yml) para no pisarle la
 * carrera a un run que todavía puede terminar solo.
 */
export const reviewSweeperScheduled = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'Etc/UTC', region: 'us-east4' },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('issues').where('status', '==', 'in_review').get();

    for (const doc of snap.docs) {
      try {
        await maybeEscalateStuckReview(db, doc);
      } catch (error) {
        console.error(`[ReviewSweeper] falló para el issue '${doc.id}':`, error);
      }
    }
  }
);

async function maybeEscalateStuckReview(db: Firestore, doc: QueryDocumentSnapshot): Promise<void> {
  const issue = doc.data();
  const review = issue.review as IssueReview | undefined;
  if (!review || review.state !== 'running' || !review.startedAt) return;

  const elapsedMs = Date.now() - new Date(review.startedAt).getTime();
  if (elapsedMs < STUCK_THRESHOLD_MS) return;

  const leadId = await resolveReviewLead(db, issue);
  const currentLabels: string[] = Array.isArray(issue.labelIds) ? issue.labelIds : [];
  const labelId = await ensureNeedsHumanLabel(db, issue.workspaceId, issue.teamId);

  const nextReview: IssueReview = {
    ...review,
    state: 'needs_human',
    previousAssigneeId: issue.assigneeId || undefined,
  };

  const now = new Date().toISOString();
  await doc.ref.update(
    cleanUndefined({
      review: nextReview,
      assigneeId: leadId || null,
      labelIds: currentLabels.includes(labelId) ? currentLabels : [...currentLabels, labelId],
      updatedAt: now,
      updatedBy: 'system',
    })
  );

  const minutes = Math.round(elapsedMs / 60000);
  const commentId = `cmt-${nanoid(8)}`;
  const reason =
    `El intento ${review.attempt} lleva ${minutes} minutos en \`running\` sin veredicto (agente ` +
    `'${review.claimedBy || review.dispatchedTo || 'desconocido'}'). El run de GitHub Actions puede no haber ` +
    'arrancado, o haberse cortado sin llegar al paso de reporte.';
  await db
    .collection('comments')
    .doc(commentId)
    .set({
      id: commentId,
      workspaceId: issue.workspaceId,
      issueId: doc.id,
      authorId: 'system',
      body: `**Revisión de QA colgada** — ${reason} Se escala a needs_human para que decida una persona.`,
      source: 'web',
      createdAt: now,
    });

  await notifyNeedsHuman(db, issue, doc.id, leadId, 'system', reason);

  console.log(`[ReviewSweeper] escaló la revisión colgada del issue '${issue.identifier}' (${doc.id}) a needs_human tras ${minutes}m.`);
}
