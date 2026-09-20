import { nanoid } from 'nanoid';
import { cleanUndefined } from './clean';

/**
 * Modelo de notificación (TES-156). Todavía no vive en
 * `pulse-app/src/types/domain.ts` (la fuente única de `domain.generated.ts`,
 * ver el comment de cabecera de ese archivo) — se define acá hasta que se
 * agregue del lado de pulse-app y se sincronice como el resto del modelo.
 */
export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'comment'
  | 'status_change'
  | 'review_result'
  | 'needs_human'
  | 'changes_requested'
  | 'due_soon';

/**
 * `changes_requested` (D16/TES-212) es "opt-in": el loop se re-trabaja solo,
 * así que por defecto nadie se entera — solo quien prendió explícitamente la
 * preferencia lo recibe. Todos los demás tipos son "opt-out" (prendidos por
 * default, ver `mutedNotificationTypes`), así que se guarda en un array
 * separado (`enabledNotificationTypes`) en vez de invertir el significado de
 * `mutedNotificationTypes` para un solo tipo.
 */
export const OPT_IN_NOTIFICATION_TYPES: NotificationType[] = ['changes_requested'];

/**
 * `needs_human` (D16/TES-212) es la notificación importante del loop: no
 * puede quedar apagada por el mute de tipo por defecto (`mutedNotificationTypes`).
 * Sigue respetando el mute puntual de un issue (`isIssueMuted`) — eso es una
 * decisión sobre ESE issue, no una forma de perderse todo el resto.
 */
export const UNMUTABLE_NOTIFICATION_TYPES: NotificationType[] = ['needs_human'];

export interface Notification {
  id: string;
  workspaceId: string;
  userId: string;
  type: NotificationType;
  issueId: string;
  // Solo poblado para `comment`/`mentioned` (TES-193): le permite al
  // frontend abrir `IssuePeekPanel` con foco en el comentario puntual en vez
  // de solo la pestaña "Comentarios".
  commentId?: string;
  actorId: string;
  title: string;
  body: string;
  read: boolean;
  readAt?: string;
  createdAt: string;
  // Snooze de una notificación individual (TES-194, ver
  // `notifications.snooze`): mientras `snoozedUntil` sea futuro, el inbox la
  // oculta filtrando client-side en `subscribeUserNotifications` — no hace
  // falta un cron que la "reintroduzca", simplemente deja de matchear el
  // filtro una vez que la fecha pasa.
  snoozedUntil?: string;
}

const MAX_BODY_LENGTH = 240;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export type NotificationInput = Omit<Notification, 'id' | 'read' | 'readAt' | 'createdAt'>;

/**
 * Chequea si `userId` silenció las notificaciones de `issueId` (TES-193, ver
 * `notifications.muteIssue`). La preferencia vive en el doc de membership
 * (`members/{workspaceId}_{userId}`) en vez de una subcolección: es un dato
 * chico y de lectura frecuente (acá, en cada notificación potencial), y ya
 * existe ese doc por usuario+workspace para todo lo demás.
 */
async function isIssueMuted(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  userId: string,
  issueId: string
): Promise<boolean> {
  const memberSnap = await db.collection('members').doc(`${workspaceId}_${userId}`).get();
  if (!memberSnap.exists) return false;
  const mutedIssueIds: string[] = memberSnap.data()!.mutedIssueIds || [];
  return mutedIssueIds.includes(issueId);
}

/**
 * Chequea si `userId` apagó (o, para un tipo opt-in, no prendió) el tipo
 * `type` de notificación (TES-194, ampliado en TES-212) — a diferencia de
 * `isIssueMuted`, esto no depende del issue, es la categoría entera para todo
 * el workspace. Misma forma de guardado que `mutedIssueIds`: un array en el
 * doc de membership.
 */
async function isTypeSuppressed(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  userId: string,
  type: NotificationType
): Promise<boolean> {
  if (UNMUTABLE_NOTIFICATION_TYPES.includes(type)) return false;

  const memberSnap = await db.collection('members').doc(`${workspaceId}_${userId}`).get();
  const memberData = memberSnap.exists ? memberSnap.data()! : {};

  if (OPT_IN_NOTIFICATION_TYPES.includes(type)) {
    const enabledTypes: string[] = memberData.enabledNotificationTypes || [];
    return !enabledTypes.includes(type);
  }

  const mutedTypes: string[] = memberData.mutedNotificationTypes || [];
  return mutedTypes.includes(type);
}

/**
 * Crea una notificación. Nunca dispara al propio actor (no tiene sentido
 * notificarle a alguien su propia acción), nunca dispara si el destinatario
 * silenció el issue, y nunca lanza: es siempre un efecto secundario de otra
 * escritura (un trigger sobre `issues`, un comentario), y un fallo acá no
 * debería tirar abajo la operación principal.
 */
export async function createNotification(
  db: FirebaseFirestore.Firestore,
  input: NotificationInput
): Promise<void> {
  if (!input.userId || input.userId === input.actorId) return;

  try {
    if (await isIssueMuted(db, input.workspaceId, input.userId, input.issueId)) return;
    if (await isTypeSuppressed(db, input.workspaceId, input.userId, input.type)) return;

    const id = `ntf-${nanoid(8)}`;
    const notification: Notification = {
      ...input,
      id,
      body: truncate(input.body, MAX_BODY_LENGTH),
      read: false,
      createdAt: new Date().toISOString(),
    };
    await db.collection('notifications').doc(id).set(cleanUndefined(notification));
  } catch (error) {
    console.error('[Notifications] failed to create notification, dropping:', error);
  }
}

type WorkspaceMemberLite = Record<string, any>;

/**
 * Menciones "@algo" en el cuerpo de un comentario. Todavía no hay un picker de
 * menciones en el frontend (la UI de comentarios es de F3), así que esto es
 * mejor esfuerzo por texto: matchea el token contra el `userId` exacto, el
 * `displayName` sin espacios (case-insensitive) o la parte local del email.
 * Cuando el picker exista y emita un formato explícito, este parser se puede
 * reemplazar sin romper nada — hoy no hay ningún consumidor que dependa de
 * esta convención.
 */
export function extractMentionedUserIds(body: string, members: WorkspaceMemberLite[]): string[] {
  const tokens = new Set(
    Array.from(body.matchAll(/@([a-zA-Z0-9_][\w.-]*)/g), (m) => m[1].toLowerCase())
  );
  if (tokens.size === 0) return [];

  const matched = new Set<string>();
  for (const member of members) {
    if (!member.userId) continue;
    const idKey = member.userId.toLowerCase();
    const displayKey = (member.displayName || '').replace(/\s+/g, '').toLowerCase();
    const emailKey = (member.email || '').split('@')[0]?.toLowerCase();
    if (tokens.has(idKey) || (displayKey && tokens.has(displayKey)) || (emailKey && tokens.has(emailKey))) {
      matched.add(member.userId);
    }
  }
  return Array.from(matched);
}
