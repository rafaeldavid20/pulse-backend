import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class CreateIssueAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.create', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.teamId || !data.title) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, teamId, title.');
    }

    const issueId = `issue-${nanoid(8)}`;
    const teamKey = data.teamKey || 'ORD';

    // Calculate next sequential issue number for this workspace/team
    let nextNum = 101;
    try {
      const qSnap = await db
        .collection('issues')
        .where('workspaceId', '==', data.workspaceId)
        .where('teamId', '==', data.teamId)
        .get();
      nextNum = qSnap.size + 101;
    } catch (e) {
      // Fallback number
    }

    const rawIssue = {
      id: issueId,
      workspaceId: data.workspaceId,
      teamId: data.teamId,
      projectId: data.projectId || null,
      identifier: `${teamKey}-${nextNum}`,
      number: nextNum,
      title: data.title.trim(),
      description: (data.description || '').trim(),
      status: data.status || 'todo',
      priority: data.priority !== undefined ? data.priority : 3,
      assigneeId: data.assigneeId || null,
      creatorId: this.caller.uid || data.creatorId || 'system',
      labelIds: data.labelIds || ['feature'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cleanIssue = cleanUndefined(rawIssue);
    await db.collection('issues').doc(issueId).set(cleanIssue);

    return cleanIssue;
  }
}
