import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { NotificationType } from '../../common/utils/notifications';

const NOTIFICATION_TYPES: NotificationType[] = [
  'assigned',
  'mentioned',
  'comment',
  'status_change',
  'review_result',
  'due_soon',
];

export class UpdateNotificationPreferencesAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('notifications.updatePreferences', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  /**
   * Apaga/prende una categoría entera de notificación (TES-194) para el
   * miembro que llama, en el workspace dado — no un issue puntual, eso ya lo
   * cubre `notifications.muteIssue`. Guardado igual que `mutedIssueIds`: un
   * array en el doc de membership, vacío por default (todo prendido), leído
   * por `createNotification` antes de generar cada notificación nueva.
   */
  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const type = this.action.data.type as NotificationType | undefined;
    const enabled = this.action.data.enabled as boolean | undefined;

    if (!type || !NOTIFICATION_TYPES.includes(type)) {
      throw new Error(`Tipo de notificación inválido: '${type}'.`);
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('Parámetro requerido faltante: enabled (boolean).');
    }

    const memberId = `${this.workspaceId}_${this.caller.uid}`;
    await db.collection('members').doc(memberId).update({
      mutedNotificationTypes: enabled ? FieldValue.arrayRemove(type) : FieldValue.arrayUnion(type),
    });

    return { workspaceId: this.workspaceId, type, enabled };
  }
}
