import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type SnoozePreset = '1h' | 'tomorrow' | 'next_week' | 'clear';

const PRESETS: Record<Exclude<SnoozePreset, 'clear'>, (now: Date) => Date> = {
  '1h': (now) => new Date(now.getTime() + HOUR_MS),
  tomorrow: (now) => new Date(now.getTime() + DAY_MS),
  next_week: (now) => new Date(now.getTime() + 7 * DAY_MS),
};

export class SnoozeNotificationAction extends PlatformActionHandler {
  private notificationId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('notifications.snooze', request, callerUid, callerEmail);
    this.notificationId = request.data?.notificationId;
  }

  // Misma razón que notifications.markRead: una notificación es privada de
  // su destinatario, no alcanza con ser miembro del workspace.
  protected async authorize(): Promise<boolean> {
    if (!this.notificationId || !this.caller.uid) return false;
    const snap = await getFirestore().collection('notifications').doc(this.notificationId).get();
    if (!snap.exists) return false;
    return snap.data()!.userId === this.caller.uid;
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const notificationId = this.action.data.notificationId as string | undefined;
    const preset = this.action.data.preset as SnoozePreset | undefined;

    if (!notificationId) {
      throw new Error('Identificador de notificación (notificationId) es obligatorio.');
    }
    if (!preset || !['1h', 'tomorrow', 'next_week', 'clear'].includes(preset)) {
      throw new Error("Preset de snooze inválido: usá '1h', 'tomorrow', 'next_week' o 'clear'.");
    }

    const ref = db.collection('notifications').doc(notificationId);
    const snap = await ref.get();
    if (!snap.exists) {
      throw new Error(`La notificación con ID '${notificationId}' no existe.`);
    }

    if (preset === 'clear') {
      await ref.update({ snoozedUntil: FieldValue.delete() });
      return { id: notificationId, snoozedUntil: null };
    }

    const snoozedUntil = PRESETS[preset](new Date()).toISOString();
    await ref.update({ snoozedUntil });
    return { id: notificationId, snoozedUntil };
  }
}
