import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class CreateProjectAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('projects.create', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.name) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, name.');
    }

    const projId = `proj-${nanoid(8)}`;
    const rawProject = {
      id: projId,
      workspaceId: data.workspaceId,
      teamId: data.teamId || 'eng',
      name: data.name.trim(),
      description: (data.description || '').trim(),
      status: data.status || 'in_progress',
      leadId: data.leadId || null,
      color: data.color || '#5E6AD2',
      targetDate: data.targetDate || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const cleanProject = cleanUndefined(rawProject);
    await db.collection('projects').doc(projId).set(cleanProject);

    return cleanProject;
  }
}
