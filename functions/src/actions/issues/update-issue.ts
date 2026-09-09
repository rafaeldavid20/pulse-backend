import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from '../../common/utils/issue-fields';
import { canHaveChildren } from '../../common/domain.generated';
import {
  adjustParentCounters,
  childIdsOf,
  doneWeight,
  normalizeIssueType,
  recomputeSubtreeEpicId,
  resolvePlacement,
} from '../../common/utils/hierarchy';

export class UpdateIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.update', request, callerUid, callerEmail);
    this.issueId = request.data?.id;
  }

  // Loads the issue to authorize against its *real* workspaceId — trusting
  // a client-supplied workspaceId would let anyone update any workspace's
  // issue just by guessing/copying an issueId (same lesson as
  // comments.create / issues.claim).
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
      throw new Error('Identificador de issue (id) es obligatorio para actualizar.');
    }

    const issueRef = db.collection('issues').doc(issueId);
    const snap = await issueRef.get();
    if (!snap.exists) {
      throw new Error(`El issue con ID '${issueId}' no existe.`);
    }
    const current = snap.data()!;

    // Whitelist, not a blind spread of `data`: this can be called from an MCP
    // tool driven by an LLM, and a spread would let it overwrite
    // server-owned fields like `workspaceId`, `identifier` or `creatorId`.
    const updates: Record<string, any> = {
      ...pickWritableFields(data, ISSUE_WRITABLE_FIELDS),
      updatedAt: new Date().toISOString(),
    };

    // --- Jerarquía --------------------------------------------------------
    // `type` y `parentId` están en la whitelist, así que ya vinieron copiados
    // arriba con el valor crudo del caller. Acá se revalidan y se reemplazan
    // por el resultado de `resolvePlacement`, que además deriva `epicId`
    // (nunca aceptado del payload).
    const touchesHierarchy = 'type' in data || 'parentId' in data;

    const nextType = normalizeIssueType('type' in data ? data.type : current.type);
    const previousParentId: string | null = current.parentId || null;
    const nextParentIdRaw: string | null =
      'parentId' in data ? data.parentId || null : previousParentId;

    let nextParentId = previousParentId;
    let nextEpicId: string | null = current.epicId || null;

    if (touchesHierarchy) {
      // Cambiar el tipo a uno que no admite hijos rompería a los que ya tiene.
      if (nextType !== normalizeIssueType(current.type) && !canHaveChildren(nextType)) {
        const children = await childIdsOf(db, issueId);
        if (children.length > 0) {
          throw new Error(
            `No se puede cambiar el tipo a '${nextType}': el issue tiene ${children.length} ` +
              'sub-issue(s). Movelos o eliminalos primero.'
          );
        }
      }

      const placement = await resolvePlacement(db, {
        workspaceId: current.workspaceId,
        type: nextType,
        parentId: nextParentIdRaw,
        issueId,
      });

      nextParentId = placement.parentId;
      nextEpicId = placement.epicId;

      updates.type = placement.type;
      updates.parentId = placement.parentId ?? FieldValue.delete();
      updates.epicId = placement.epicId ?? FieldValue.delete();
    }

    await issueRef.update(cleanUndefined(updates));

    // --- Contadores del padre --------------------------------------------
    // Después del write, para no dejar contadores movidos si el update falla.
    const previousDone = doneWeight(current.status);
    const nextDone = doneWeight('status' in data ? data.status : current.status);

    if (nextParentId !== previousParentId) {
      await adjustParentCounters(db, previousParentId, -1, -previousDone);
      await adjustParentCounters(db, nextParentId, 1, nextDone);
      // Las sub-tareas siguen a su historia cuando cambia de épica.
      await recomputeSubtreeEpicId(db, issueId, nextEpicId);
    } else if (nextDone !== previousDone) {
      await adjustParentCounters(db, previousParentId, 0, nextDone - previousDone);
    }

    return { id: issueId, ...updates };
  }
}
