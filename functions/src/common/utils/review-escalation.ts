import { nanoid } from 'nanoid';

export const NEEDS_HUMAN_LABEL = 'needs-human';
const NEEDS_HUMAN_LABEL_COLOR = '#E5484D';

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
  if (issue.projectId) {
    const projectSnap = await db.collection('projects').doc(issue.projectId).get();
    const leadId = projectSnap.exists ? projectSnap.data()!.leadId : undefined;
    if (leadId) return leadId;
  }
  return issue.creatorId;
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
