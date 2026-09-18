import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { nextIssueNumber } from '../../common/utils/counters';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from '../../common/utils/issue-fields';
import {
  adjustParentCounters,
  doneWeight,
  normalizeIssueType,
  resolvePlacement,
} from '../../common/utils/hierarchy';

/**
 * Duplica un issue: crea uno nuevo en el mismo workspace/team con el mismo
 * título, descripción, tipo, prioridad, labels, proyecto, estimate, dueDate,
 * ciclo, repo y padre que el original. Es la acción rápida "duplicar" de la
 * cola de triage (TES-157), para partir un issue huérfano en dos sin
 * retipear todo.
 *
 * A propósito NO copia `status` (la copia siempre arranca en 'todo') ni
 * `assigneeId`/`git.branch`/`agent`: son estado de *trabajo* del original,
 * no parte de lo que se está duplicando.
 */
export class DuplicateIssueAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.duplicate', request, callerUid, callerEmail);
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
    const sourceId = this.action.data.id as string | undefined;

    if (!sourceId) {
      throw new Error('Identificador de issue (id) es obligatorio para duplicar.');
    }

    const sourceSnap = await db.collection('issues').doc(sourceId).get();
    if (!sourceSnap.exists) {
      throw new Error(`El issue con ID '${sourceId}' no existe.`);
    }
    const source = sourceSnap.data()!;

    const issueId = `issue-${nanoid(8)}`;
    const teamDoc = await db.collection('teams').doc(source.teamId).get();
    const teamKey = teamDoc.exists ? teamDoc.data()!.key : 'ORD';

    // Mismo padre que el original: la copia se cuelga del mismo lugar del
    // árbol (resolvePlacement resuelve `parentId: null` igual que en
    // `issues.create`, así que un original huérfano da una copia huérfana).
    const placement = await resolvePlacement(db, {
      workspaceId: source.workspaceId,
      type: normalizeIssueType(source.type),
      parentId: source.parentId || null,
    });

    // Misma reserva atómica de número que `issues.create` — ver ahí el porqué
    // del `seedFn`.
    const nextNum = await nextIssueNumber(db, source.workspaceId, source.teamId, async () => {
      const existing = await db
        .collection('issues')
        .where('workspaceId', '==', source.workspaceId)
        .where('teamId', '==', source.teamId)
        .get();
      let maxNumber = 100;
      existing.forEach((d) => {
        const n = d.data().number;
        if (typeof n === 'number' && n > maxNumber) maxNumber = n;
      });
      return maxNumber + 1;
    });

    const rawIssue: Record<string, any> = {
      ...pickWritableFields(source, ISSUE_WRITABLE_FIELDS),
      id: issueId,
      workspaceId: source.workspaceId,
      teamId: source.teamId,
      identifier: `${teamKey}-${nextNum}`,
      number: nextNum,
      title: source.title,
      description: source.description || '',
      subIssueCount: 0,
      subIssueDoneCount: 0,
      creatorId: this.caller.uid || 'system',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: this.caller.uid || 'system',
      // Pisan lo que haya venido de `pickWritableFields`: jerarquía derivada
      // de `resolvePlacement` (nunca copiada tal cual) y estado de trabajo
      // que no le corresponde a una copia recién creada.
      type: placement.type,
      parentId: placement.parentId,
      epicId: placement.epicId,
      status: 'todo',
      assigneeId: null,
    };

    if (source.git?.repoFullName) {
      rawIssue.git = { repoFullName: source.git.repoFullName };
    }

    const cleanIssue = cleanUndefined(rawIssue);
    await db.collection('issues').doc(issueId).set(cleanIssue);

    await adjustParentCounters(db, placement.parentId, 1, doneWeight(cleanIssue.status));

    return cleanIssue;
  }
}
