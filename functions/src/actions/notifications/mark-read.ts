import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

export class MarkNotificationReadAction extends PlatformActionHandler {
  private notificationId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('notifications.markRead', request, callerUid, callerEmail);
    this.notificationId = request.data?.notificationId;
  }

  // Una notificación es privada de su destinatario — no alcanza con ser
  // miembro del workspace, tiene que ser la persona a la que se le notificó.
  protected async authorize(): Promise<boolean> {
    if (!this.notificationId || !this.caller.uid) return false;
    const snap = await getFirestore().collection('notifications').doc(this.notificationId).get();
    if (!snap.exists) return false;
    return snap.data()!.userId === this.caller.uid;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const notificationId = this.action.data.notificationId as string | undefined;

    if (!notificationId) {
      throw new Error('Identificador de notificación (notificationId) es obligatorio.');
    }

    const ref = db.collection('notifications').doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`La notificación con ID '${notificationId}' no existe.`);
    }

    const readAt = new Date().toISOString();
    await ref.update({ read: true, readAt });

    return { id: notificationId, read: true, readAt };
  }
}
