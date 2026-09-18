import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getStatusLabel } from '../common/domain.generated';
import { createNotification } from '../common/utils/notifications';

/**
 * Genera notificaciones `assigned` y `status_change` (TES-156) a partir de
 * cualquier escritura sobre un issue, sin importar qué acción la disparó
 * (`issues.update`, `issues.claim`, `issues.claimNext`, `issues.release`,
 * `issues.requestRepoWork`, el sync de GitHub) — centralizarlo acá en vez de
 * repetirlo en cada acción sigue el mismo patrón que `agentDispatchTrigger`.
 *
 * El actor de la escritura no está en el modelo de `Issue`, así que cada
 * acción que puede tocar `status`/`assigneeId` estampa `updatedBy` junto con
 * `updatedAt`. Sin eso, un self-claim (`issues.claim`/`claimNext`, donde el
 * actor y el nuevo asignado son la misma persona) se vería igual que una
 * asignación hecha por otro y notificaría de más.
 */
export const issueNotificationsTrigger = onDocumentWritten(
  { document: 'issues/{issueId}', region: 'us-east4' },
  async (event) => {
    try {
      const before = event.data?.before.data();
      const after = event.data?.after.data();
      if (!after) return; // borrado, nada que notificar

      const issueId = event.params.issueId;
      const actorId = after.updatedBy || 'system';
      const db = getFirestore();

      if (after.assigneeId && after.assigneeId !== before?.assigneeId) {
        await createNotification(db, {
          workspaceId: after.workspaceId,
          userId: after.assigneeId,
          actorId,
          issueId,
          type: 'assigned',
          title: `Te asignaron ${after.identifier}`,
          body: after.title || '',
        });
      }

      if (before && after.status !== before.status && after.assigneeId) {
        await createNotification(db, {
          workspaceId: after.workspaceId,
          userId: after.assigneeId,
          actorId,
          issueId,
          type: 'status_change',
          title: `${after.identifier} cambió de estado`,
          body: `${getStatusLabel(before.status)} → ${getStatusLabel(after.status)}`,
        });
      }
    } catch (error) {
      console.error('[IssueNotifications] error handling issue write, will not retry:', error);
    }
  }
);
