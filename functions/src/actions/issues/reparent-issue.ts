import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import {
  adjustParentCounters,
  doneWeight,
  normalizeIssueType,
  recomputeSubtreeEpicId,
  resolvePlacement,
} from '../../common/utils/hierarchy';

/**
 * Mueve un issue dentro del árbol: le cambia el padre (o lo deja huérfano con
 * `parentId: null`), arrastrando su subárbol.
 *
 * Existe aparte de `issues.update` aunque haya solapamiento porque hace algo
 * distinto: `update` cambia campos de *un* issue, mientras que esto reescribe
 * el `epicId` de N descendientes y mueve contadores en dos padres. Tenerlo como
 * acción propia hace que el log de auditoría de `platform_actions` distinga
 * "editaron el título" de "reorganizaron la jerarquía", que es exactamente la
 * clase de cambio que uno quiere poder rastrear después.
 */
export class ReparentIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.reparent', request, callerUid, callerEmail);
    this.issueId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const issueId = data.id as string | undefined;

    if (!issueId) {
      throw new Error('Identificador de issue (id) es obligatorio para reubicar.');
    }
    if (!('parentId' in data)) {
      throw new Error(
        'Falta "parentId". Usá `null` explícito para sacar el issue de su padre actual.'
      );
    }

    const issueRef = db.collection('issues').doc(issueId);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${issueId}' no existe.`);
    }
    const current = snap.data()!;
    const previousParentId: string | null = current.parentId || null;
    const targetParentId: string | null = data.parentId || null;

    if (previousParentId === targetParentId) {
      return { id: issueId, parentId: targetParentId, epicId: current.epicId || null, moved: false };
    }

    const placement = await resolvePlacement(db, {
      workspaceId: current.workspaceId,
      type: normalizeIssueType(current.type),
      parentId: targetParentId,
      issueId,
    });

    await issueRef.update({
      parentId: placement.parentId ?? FieldValue.delete(),
      epicId: placement.epicId ?? FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });

    const done = doneWeight(current.status);
    await adjustParentCounters(db, previousParentId, -1, -done);
    await adjustParentCounters(db, placement.parentId, 1, done);
    const descendantsUpdated = await recomputeSubtreeEpicId(db, issueId, placement.epicId);

    return {
      id: issueId,
      parentId: placement.parentId,
      epicId: placement.epicId,
      previousParentId,
      descendantsUpdated,
      moved: true,
    };
  }
}
