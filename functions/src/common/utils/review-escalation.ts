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
