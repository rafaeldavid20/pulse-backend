import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class CreateLabelAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('labels.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.teamId || !data.name || !data.color) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, teamId, name, color.');
    }

    const labelId = `lbl-${nanoid(8)}`;
    const label = {
      id: labelId,
      workspaceId: data.workspaceId,
      teamId: data.teamId,
      name: String(data.name).trim().toLowerCase(),
      color: data.color,
    };

    const cleanLabel = cleanUndefined(label);
    await db.collection('labels').doc(labelId).set(cleanLabel);

    return cleanLabel;
  }
}
