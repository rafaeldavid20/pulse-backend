import { nanoid } from 'nanoid';

/**
 * Etiquetas que el backend crea solo, sin que nadie las haya definido en la UI.
 *
 * Son parte del contrato de una feature, no preferencias del workspace: si la
 * etiqueta no existe, el mecanismo que la usa queda mudo. Por eso se crean bajo
 * demanda y de forma idempotente, en vez de asumir que alguien las va a haber
 * configurado antes.
 */
export const NEEDS_HUMAN_LABEL = 'needs-human';
export const NEEDS_HUMAN_LABEL_COLOR = '#E5484D';

/** Marca el issue de seguimiento de un pendiente que ningún run puede tomar (TES-219). */
export const MANUAL_WORK_LABEL = 'trabajo-manual';
export const MANUAL_WORK_LABEL_COLOR = '#F09436';

/**
 * Reusa la etiqueta del workspace si ya existe; si no, la crea. Idempotente a
 * propósito: varias rutas distintas (escalamiento de QA, pendientes de TES-219)
 * piden la misma etiqueta y ninguna puede asumir que fue la primera.
 *
 * La búsqueda es por `workspaceId` + `name` y no por un id fijo porque la
 * etiqueta también se puede haber creado a mano desde la UI con ese nombre — en
 * ese caso se adopta esa, en vez de crear una duplicada con el mismo nombre.
 */
export async function ensureLabel(
  db: FirebaseFirestore.Firestore,
  workspaceId: string,
  teamId: string,
  name: string,
  color: string
): Promise<string> {
  const found = await db
    .collection('labels')
    .where('workspaceId', '==', workspaceId)
    .where('name', '==', name)
    .limit(1)
    .get();
  if (!found.empty) return found.docs[0].id;
  const labelId = `lbl-${nanoid(8)}`;
  await db.collection('labels').doc(labelId).set({ id: labelId, workspaceId, teamId, name, color });
  return labelId;
}

/** Agrega `labelId` a `labelIds` si no estaba. Devuelve `undefined` si no hay nada que cambiar. */
export function withLabel(labelIds: unknown, labelId: string): string[] | undefined {
  const current: string[] = Array.isArray(labelIds) ? labelIds : [];
  return current.includes(labelId) ? undefined : [...current, labelId];
}
