import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { isCompletedStatus } from '../common/domain.generated';
import { createNotification } from '../common/utils/notifications';

const WINDOW_HOURS = 48;
const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Cloud Function programada (F5): recorre issues con `dueDate` dentro de las
 * próximas 48h, status no terminal (`isCompletedStatus`) y asignado, y emite
 * una notificación `due_soon` (F1) al asignado.
 *
 * El query solo filtra por rango en `dueDate` (así alcanza con el índice
 * single-field automático, sin agregar uno compuesto); status, asignación e
 * idempotencia se resuelven en memoria por issue abajo.
 *
 * Idempotencia: `dueSoonNotifiedAt` se estampa en el issue al notificar y se
 * chequea acá para no repetir la misma alerta en cada corrida. Si `dueDate`
 * cambia después de notificar, `issues.update` lo resetea (ver ese action)
 * para permitir una nueva alerta.
 */
export const dueSoonRemindersScheduled = onSchedule(
  { schedule: 'every 4 hours', timeZone: 'Etc/UTC', region: 'us-east4' },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_HOURS * MS_PER_HOUR);

    const dueSoonSnap = await db
      .collection('issues')
      .where('dueDate', '>=', now.toISOString())
      .where('dueDate', '<=', windowEnd.toISOString())
      .get();

    for (const doc of dueSoonSnap.docs) {
      try {
        await maybeNotifyDueSoon(db, doc);
      } catch (error) {
        console.error(`[dueSoonReminders] Falló para el issue '${doc.id}':`, error);
      }
    }
  }
);

async function maybeNotifyDueSoon(
  db: FirebaseFirestore.Firestore,
  doc: QueryDocumentSnapshot
): Promise<void> {
  const issue = doc.data();
  if (!issue.assigneeId) return;
  if (isCompletedStatus(issue.status)) return;
  if (issue.dueSoonNotifiedAt) return;

  await createNotification(db, {
    workspaceId: issue.workspaceId,
    userId: issue.assigneeId,
    actorId: 'system',
    issueId: doc.id,
    type: 'due_soon',
    title: `${issue.identifier} vence pronto`,
    body: issue.title || '',
  });

  await doc.ref.update({ dueSoonNotifiedAt: new Date().toISOString() });
}
