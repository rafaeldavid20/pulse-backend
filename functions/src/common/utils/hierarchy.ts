import { Firestore, FieldValue } from 'firebase-admin/firestore';
import {
  IssueType,
  ISSUE_TYPES,
  DEFAULT_ISSUE_TYPE,
  MAX_HIERARCHY_DEPTH,
  canHaveParent,
  canBeChild,
  resolveEpicId,
  isCompletedStatus,
  getIssueTypeLabel,
} from '../domain.generated';

/**
 * Toda la lógica de jerarquía de issues (épica → historia → sub-tarea) del lado
 * servidor. Las *reglas* viven en `domain.generated.ts` (tabla
 * `ALLOWED_PARENT_TYPES`, compartida con el frontend); acá está lo que necesita
 * tocar Firestore para hacerlas cumplir: resolver el `epicId` denormalizado,
 * detectar ciclos y mantener los contadores del padre.
 *
 * Invariantes que este módulo sostiene:
 *  - `epicId` de un issue es la épica raíz de su subárbol, y `undefined` para
 *    las épicas mismas (una épica no se apunta a sí misma).
 *  - `subIssueCount` / `subIssueDoneCount` de un padre siempre reflejan sus
 *    hijos directos. Se mantienen con `FieldValue.increment`, que es atómico
 *    sin necesidad de transacción.
 *  - Un `parentId` nunca apunta a un descendiente (sin ciclos).
 */

export interface HierarchyPlacement {
  type: IssueType;
  /** `null` — no `undefined` — para poder borrar el campo en un update. */
  parentId: string | null;
  epicId: string | null;
}

const VALID_TYPES = new Set<string>(ISSUE_TYPES.map((t) => t.value));

/** Valida y normaliza el `type` de un issue; `undefined` cae al default. */
export function normalizeIssueType(raw: unknown): IssueType {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_ISSUE_TYPE;
  if (typeof raw !== 'string' || !VALID_TYPES.has(raw)) {
    throw new Error(
      `Tipo de issue inválido: '${String(raw)}'. Válidos: ${ISSUE_TYPES.map((t) => t.value).join(', ')}.`
    );
  }
  return raw as IssueType;
}

/**
 * Resuelve dónde va a colgar un issue, validando las reglas de jerarquía y
 * devolviendo el `epicId` derivado.
 *
 * `issueId` se pasa solo en updates/reparents: es el issue que se está
 * moviendo, y sirve para rechazar que se cuelgue de sí mismo o de un
 * descendiente suyo.
 */
export async function resolvePlacement(
  db: Firestore,
  opts: {
    workspaceId: string;
    type: IssueType;
    parentId?: string | null;
    issueId?: string;
  }
): Promise<HierarchyPlacement> {
  const { workspaceId, type, issueId } = opts;
  const parentId = opts.parentId || null;

  if (!parentId) {
    return { type, parentId: null, epicId: null };
  }

  if (!canBeChild(type)) {
    throw new Error(
      `Un issue de tipo '${getIssueTypeLabel(type)}' no puede tener padre.`
    );
  }

  if (issueId && parentId === issueId) {
    throw new Error('Un issue no puede ser su propio padre.');
  }

  const parentSnap = await db.collection('issues').doc(parentId).get();
  if (!parentSnap.exists) {
    throw new Error(`El issue padre '${parentId}' no existe.`);
  }
  const parent = parentSnap.data()!;

  if (parent.workspaceId !== workspaceId) {
    throw new Error('El issue padre pertenece a otro workspace.');
  }

  const parentType = normalizeIssueType(parent.type);
  if (!canHaveParent(type, parentType)) {
    throw new Error(
      `Un issue de tipo '${getIssueTypeLabel(type)}' no puede colgar de uno de tipo ` +
        `'${getIssueTypeLabel(parentType)}'.`
    );
  }

  if (issueId) {
    await assertNotDescendant(db, issueId, parentId);
  }

  return {
    type,
    parentId,
    epicId: resolveEpicId({ id: parentSnap.id, type: parentType, epicId: parent.epicId }) || null,
  };
}

/**
 * Falla si `candidateParentId` es descendiente de `ancestorId` (lo que crearía
 * un ciclo). Sube por la cadena de padres, que la tabla de tipos ya acota a
 * `MAX_HIERARCHY_DEPTH` niveles; el tope del loop es una red de seguridad por
 * si quedaran datos inconsistentes de antes de esta validación.
 */
export async function assertNotDescendant(
  db: Firestore,
  ancestorId: string,
  candidateParentId: string
): Promise<void> {
  let currentId: string | undefined = candidateParentId;

  for (let hops = 0; currentId && hops <= MAX_HIERARCHY_DEPTH + 1; hops++) {
    if (currentId === ancestorId) {
      throw new Error(
        'No se puede mover un issue dentro de su propio subárbol (crearía un ciclo).'
      );
    }
    const snap: FirebaseFirestore.DocumentSnapshot = await db
      .collection('issues')
      .doc(currentId)
      .get();
    if (!snap.exists) return;
    currentId = snap.data()!.parentId || undefined;
  }
}

/**
 * Ajusta los contadores denormalizados de un padre. `null`/`undefined` es
 * no-op, así los callers no tienen que preguntarse si había padre.
 */
export async function adjustParentCounters(
  db: Firestore,
  parentId: string | null | undefined,
  countDelta: number,
  doneDelta: number
): Promise<void> {
  if (!parentId) return;
  if (countDelta === 0 && doneDelta === 0) return;

  const updates: Record<string, FirebaseFirestore.FieldValue> = {};
  if (countDelta !== 0) updates.subIssueCount = FieldValue.increment(countDelta);
  if (doneDelta !== 0) updates.subIssueDoneCount = FieldValue.increment(doneDelta);

  // El padre puede haber sido borrado entre la lectura y esta escritura; un
  // contador desactualizado no justifica hacer fallar la acción del usuario.
  try {
    await db.collection('issues').doc(parentId).update(updates);
  } catch (error) {
    console.warn(`[hierarchy] no se pudieron ajustar los contadores de '${parentId}':`, error);
  }
}

/** Cuánto suma un issue al `subIssueDoneCount` de su padre: 1 si está cerrado. */
export function doneWeight(status: unknown): number {
  return typeof status === 'string' && isCompletedStatus(status) ? 1 : 0;
}

/** Ids de los hijos directos de un issue. */
export async function childIdsOf(db: Firestore, parentId: string): Promise<string[]> {
  const snap = await db.collection('issues').where('parentId', '==', parentId).get();
  return snap.docs.map((d) => d.id);
}

/**
 * Reescribe el `epicId` de todo el subárbol que cuelga de `rootId` (sin incluir
 * a `rootId`, cuyo `epicId` lo setea el caller). Se llama después de un
 * reparent: si una historia se mueve de una épica a otra, sus sub-tareas tienen
 * que seguirla.
 */
export async function recomputeSubtreeEpicId(
  db: Firestore,
  rootId: string,
  epicId: string | null
): Promise<number> {
  let frontier = await childIdsOf(db, rootId);
  let touched = 0;

  for (let depth = 0; frontier.length > 0 && depth < MAX_HIERARCHY_DEPTH; depth++) {
    const batch = db.batch();
    for (const id of frontier) {
      batch.update(db.collection('issues').doc(id), {
        epicId: epicId ?? FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
    }
    await batch.commit();
    touched += frontier.length;

    const next: string[] = [];
    for (const id of frontier) next.push(...(await childIdsOf(db, id)));
    frontier = next;
  }

  return touched;
}

/** Todos los ids del subárbol de `rootId`, incluyéndolo. */
export async function collectSubtree(db: Firestore, rootId: string): Promise<string[]> {
  const ids = [rootId];
  let frontier = [rootId];

  for (let depth = 0; frontier.length > 0 && depth < MAX_HIERARCHY_DEPTH; depth++) {
    const next: string[] = [];
    for (const id of frontier) next.push(...(await childIdsOf(db, id)));
    ids.push(...next);
    frontier = next;
  }

  return ids;
}

/**
 * Desprende a los hijos directos de un issue: quedan sin padre y sin épica,
 * pero vivos. Es el comportamiento por defecto al borrar un padre — borrar en
 * cascada sin pedirlo es destructivo e irreversible.
 */
export async function detachChildren(db: Firestore, parentId: string): Promise<number> {
  const ids = await childIdsOf(db, parentId);
  if (ids.length === 0) return 0;

  const batch = db.batch();
  for (const id of ids) {
    batch.update(db.collection('issues').doc(id), {
      parentId: FieldValue.delete(),
      epicId: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });
  }
  await batch.commit();

  return ids.length;
}
