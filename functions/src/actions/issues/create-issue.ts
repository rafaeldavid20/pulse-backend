import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { nextIssueNumber } from '../../common/utils/counters';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from '../../common/utils/issue-fields';
import { validateRepoForWorkspace } from '../../common/utils/repo-field';
import {
  adjustParentCounters,
  doneWeight,
  normalizeIssueType,
  resolvePlacement,
} from '../../common/utils/hierarchy';

export class CreateIssueAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.teamId || !data.title) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, teamId, title.');
    }

    const issueId = `issue-${nanoid(8)}`;
    // Resolve the real team key instead of trusting a caller-supplied
    // `teamKey` — a caller that doesn't send it explicitly (e.g. this same
    // issue, created via curl) used to fall back straight to 'ORD' and get
    // an identifier with the wrong prefix.
    const teamDoc = await db.collection('teams').doc(data.teamId).get();
    const teamKey = teamDoc.exists ? teamDoc.data()!.key : data.teamKey || 'ORD';

    // Se resuelve la ubicación jerárquica *antes* de reservar el número de
    // issue: si el padre es inválido, no queremos haber consumido un número
    // del contador para un issue que no se va a crear.
    const placement = await resolvePlacement(db, {
      workspaceId: data.workspaceId,
      type: normalizeIssueType(data.type),
      parentId: data.parentId,
    });

    // Atomically reserve the next sequential issue number for this
    // workspace/team via a Firestore transaction-backed counter — avoids the
    // race condition of counting existing docs (two concurrent creates could
    // read the same count and mint the same identifier). The seed function
    // only runs once, the first time this workspace/team creates an issue
    // under the new counter scheme: it backfills the counter from the
    // highest existing issue number so teams with issues already created
    // under the old `count + 101` scheme don't get colliding identifiers.
    const nextNum = await nextIssueNumber(db, data.workspaceId, data.teamId, async () => {
      const existing = await db
        .collection('issues')
        .where('workspaceId', '==', data.workspaceId)
        .where('teamId', '==', data.teamId)
        .get();
      let maxNumber = 100;
      existing.forEach((d) => {
        const n = d.data().number;
        if (typeof n === 'number' && n > maxNumber) maxNumber = n;
      });
      return maxNumber + 1;
    });

    const rawIssue = {
      // Fields not present in `data` (or explicitly server-controlled) are
      // set first so they can't be overridden by a caller-supplied field of
      // the same name below.
      ...pickWritableFields(data, ISSUE_WRITABLE_FIELDS),
      id: issueId,
      workspaceId: data.workspaceId,
      teamId: data.teamId,
      identifier: `${teamKey}-${nextNum}`,
      number: nextNum,
      title: data.title.trim(),
      description: (data.description || '').trim(),
      status: data.status || 'todo',
      // Sobrescriben lo que haya venido del caller vía `pickWritableFields`:
      // `type` y `parentId` ya pasaron por la validación de jerarquía, y
      // `epicId` es derivado, nunca aceptado del payload.
      type: placement.type,
      parentId: placement.parentId,
      epicId: placement.epicId,
      subIssueCount: 0,
      subIssueDoneCount: 0,
      priority: data.priority !== undefined ? data.priority : 3,
      projectId: data.projectId || null,
      assigneeId: data.assigneeId || null,
      creatorId: this.caller.uid || data.creatorId || 'system',
      labelIds: data.labelIds || ['feature'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Mismo trato que en `issues.update`: `repoFullName` llega a nivel raíz y
    // se guarda anidado bajo `git`, porque la whitelist solo maneja campos planos.
    if (data.repoFullName) {
      await validateRepoForWorkspace(db, data.workspaceId, data.repoFullName);
      (rawIssue as Record<string, any>).git = { repoFullName: data.repoFullName };
    }

    const cleanIssue = cleanUndefined(rawIssue);
    await db.collection('issues').doc(issueId).set(cleanIssue);

    await adjustParentCounters(db, placement.parentId, 1, doneWeight(cleanIssue.status));

    return cleanIssue;
  }
}
