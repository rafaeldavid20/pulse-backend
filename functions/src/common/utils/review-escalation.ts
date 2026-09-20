import { nanoid } from 'nanoid';
import { createNotification } from './notifications';

export const NEEDS_HUMAN_LABEL = 'needs-human';
const NEEDS_HUMAN_LABEL_COLOR = '#E5484D';

/**
 * `Project.leadId` del proyecto del issue, si tiene uno asignado. Separado de
 * `resolveReviewLead` (que además hace fallback al creador) porque D16/TES-212
 * necesita distinguir "hay lead" de "no hay lead, uso al creador" para no
 * mandarle dos notificaciones a la misma persona.
 */
export async function getProjectLeadId(
  db: FirebaseFirestore.Firestore,
  projectId?: string
): Promise<string | undefined> {
  if (!projectId) return undefined;
  const projectSnap = await db.collection('projects').doc(projectId).get();
  return projectSnap.exists ? projectSnap.data()!.leadId : undefined;
}

/**
 * A quién escalar un issue que necesita una decisión humana (D3/D6): el lead
 * del proyecto si tiene uno asignado, si no quien creó el issue. Compartido
 * entre `reviews.submit` (D5), `reviews.reportIncomplete` (D6) y el barrido de
 * revisiones colgadas (D6) — las tres rutas que empujan a `needs_human`.
 */
export async function resolveReviewLead(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData
): Promise<string | undefined> {
  const leadId = await getProjectLeadId(db, issue.projectId);
  return leadId || issue.creatorId;
}

/**
 * Notificación `needs_human` (D16/TES-212) al responsable ya resuelto por
 * `resolveReviewLead` — una sola, sin importar cuál de las tres rutas de
 * escalamiento la dispare (criterio de aceptación de TES-212: "exactamente
 * una notificación al responsable"). No hace falta un flag para saltear el
 * mute de tipo por defecto: `createNotification` ya lo bypassea para este
 * tipo (ver `UNMUTABLE_NOTIFICATION_TYPES`).
 */
export async function notifyNeedsHuman(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData,
  issueId: string,
  responsibleId: string | undefined,
  actorId: string,
  reason: string
): Promise<void> {
  if (!responsibleId) return;
  await createNotification(db, {
    workspaceId: issue.workspaceId,
    userId: responsibleId,
    actorId,
    issueId,
    type: 'needs_human',
    title: `${issue.identifier} necesita una decisión`,
    body: reason,
  });
}

/**
 * Payload de escalamiento a `needs_human` para el tope de runs por issue
 * (`Workspace.maxRunsPerIssue`, D8/TES-153): a diferencia de
 * `maxReviewAttempts` (que ya venía escalado por `reviews.submit` para cuando
 * el dispatch de QA lo vuelve a chequear), este tope se descubre recién acá,
 * en el propio trigger de dispatch — así que el trigger es quien tiene que
 * reasignar y etiquetar, no solo saltear el dispatch.
 *
 * Deja `status: 'in_progress'` (y `git.lastSyncedStatus` al día, mismo motivo
 * que en `reviews.submit`) para sacar al issue de `todo`/`in_review` y que
 * ningún trigger de dispatch lo vuelva a levantar.
 */
export async function buildNeedsHumanEscalation(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData
): Promise<Record<string, any>> {
  const leadId = await resolveReviewLead(db, issue);
  const currentLabels: string[] = Array.isArray(issue.labelIds) ? issue.labelIds : [];
  const labelId = await ensureNeedsHumanLabel(db, issue.workspaceId, issue.teamId);

  const updates: Record<string, any> = {
    assigneeId: leadId || null,
    status: 'in_progress',
    'git.lastSyncedStatus': 'in_progress',
    updatedAt: new Date().toISOString(),
  };
  if (!currentLabels.includes(labelId)) {
    updates.labelIds = [...currentLabels, labelId];
  }
  return updates;
}

/**
 * Idempotente: reusa la label `needs-human` del workspace si ya existe (la
 * crea `reviews.submit` la primera vez), en vez de duplicarla por ruta de
 * escalamiento.
 */
export async function ensureNeedsHumanLabel(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  teamId: string
): Promise<string> {
  const found = await db
    .collection('labels')
    .where('workspaceId', '==', workspaceId)
    .where('name', '==', NEEDS_HUMAN_LABEL)
    .limit(1)
    .get();
  if (!found.empty) return found.docs[0].id;
  const labelId = `lbl-${nanoid(8)}`;
  await db
    .collection('labels')
    .doc(labelId)
    .set({ id: labelId, workspaceId, teamId, name: NEEDS_HUMAN_LABEL, color: NEEDS_HUMAN_LABEL_COLOR });
  return labelId;
}
