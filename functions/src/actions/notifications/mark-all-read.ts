import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

const BATCH_SIZE = 400; // margen bajo el límite de 500 escrituras de Firestore

export class MarkAllNotificationsReadAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('notifications.markAllRead', request, callerUid, callerEmail);
  }

  // Sin `workspaceId` en el payload (la vista de Inbox es cross-workspace,
  // igual que `subscribeAllUserNotifications`): la query ya filtra por
  // `userId == caller.uid`, así que el default de la clase base (requerir un
  // caller autenticado) alcanza — nadie puede tocar notificaciones ajenas.

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const uid = this.caller.uid!;
    const readAt = new Date().toISOString();

    const unreadSnap = await db
      .collection('notifications')
      .where('userId', '==', uid)
      .where('read', '==', false)
      .get();

    const docs = unreadSnap.docs;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const doc of docs.slice(i, i + BATCH_SIZE)) {
        batch.update(doc.ref, { read: true, readAt });
      }
      await batch.commit();
    }

    return { count: docs.length, readAt };
  }
}
