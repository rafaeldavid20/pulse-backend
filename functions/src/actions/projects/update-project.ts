import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { PROJECT_WRITABLE_FIELDS } from '../../common/utils/project-fields';
import { pickWritableFields } from '../../common/utils/issue-fields';

export class UpdateProjectAction extends PlatformActionHandler {
  private projectId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('projects.update', request, callerUid, callerEmail);
    this.projectId = request.data?.id;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.projectId) return false;
    const snap = await getFirestore().collection('projects').doc(this.projectId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const projId = data.id as string | undefined;

    if (!projId) {
      throw new Error('Identificador de proyecto (id) es obligatorio para actualizar.');
    }

    const projRef = db.collection('projects').doc(projId);
    const snap = await projRef.get();
    if (!snap.exists) {
      throw new Error(`El proyecto con ID '${projId}' no existe.`);
    }

    // Whitelist, not a blind spread of `data`: this can be called from an
    // MCP tool driven by an LLM (or, previously, would've let any caller
    // overwrite `workspaceId`/`teamId` on the project).
    const updates = cleanUndefined({
      ...pickWritableFields(data, PROJECT_WRITABLE_FIELDS),
      updatedAt: new Date().toISOString(),
    });

    await projRef.update(updates);

    return { id: projId, ...updates };
  }
}
