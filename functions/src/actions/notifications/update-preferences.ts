import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { NotificationType, OPT_IN_NOTIFICATION_TYPES, UNMUTABLE_NOTIFICATION_TYPES } from '../../common/utils/notifications';

const ALL_NOTIFICATION_TYPES: NotificationType[] = [
  'assigned',
  'mentioned',
  'comment',
  'status_change',
  'review_result',
  'changes_requested',
  'due_soon',
];

// `needs_human` (D16/TES-212) queda afuera: no es configurable, siempre pasa
// (ver `UNMUTABLE_NOTIFICATION_TYPES`).
const NOTIFICATION_TYPES: NotificationType[] = ALL_NOTIFICATION_TYPES.filter(
  (type) => !UNMUTABLE_NOTIFICATION_TYPES.includes(type)
);

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
   * array en el doc de membership, leído por `createNotification` antes de
   * generar cada notificación nueva.
   *
   * La mayoría de los tipos son opt-out (`mutedNotificationTypes`, vacío por
   * default = todo prendido); `changes_requested` (TES-212) es opt-in
   * (`enabledNotificationTypes`, vacío por default = apagado) porque el loop
   * lo resuelve solo y no tiene sentido molestar a nadie salvo que lo pida.
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
    const isOptIn = OPT_IN_NOTIFICATION_TYPES.includes(type);
    await db
      .collection('members')
      .doc(memberId)
      .update(
        isOptIn
          ? { enabledNotificationTypes: enabled ? FieldValue.arrayUnion(type) : FieldValue.arrayRemove(type) }
          : { mutedNotificationTypes: enabled ? FieldValue.arrayRemove(type) : FieldValue.arrayUnion(type) }
      );

    return { workspaceId: this.workspaceId, type, enabled };
  }
}
