import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { ISSUE_WRITABLE_FIELDS, pickWritableFields } from '../../common/utils/issue-fields';

export class UpdateIssueAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.update', request, callerUid, callerEmail);
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

    // Whitelist, not a blind spread of `data`: this can be called from an MCP
    // tool driven by an LLM, and a spread would let it overwrite
    // server-owned fields like `workspaceId`, `identifier` or `creatorId`.
    const updates = cleanUndefined({
      ...pickWritableFields(data, ISSUE_WRITABLE_FIELDS),
      updatedAt: new Date().toISOString(),
    });

    await issueRef.update(updates);

    return { id: issueId, ...updates };
  }
}
