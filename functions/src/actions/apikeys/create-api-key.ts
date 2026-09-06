import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { generateApiKey, hashApiKeySecret } from '../../common/utils/api-key';
import { mcpKeyPepper } from '../../common/secrets';

const DEFAULT_SCOPES = ['issues:read', 'issues:write', 'projects:write', 'comments:write'];

export class CreateApiKeyAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('apikeys.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.name) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, name.');
    }

    const { keyId, secret, fullKey, prefix } = generateApiKey();
    const hash = hashApiKeySecret(secret, mcpKeyPepper.value());

    const record = {
      id: keyId,
      workspaceId: data.workspaceId,
      name: String(data.name).trim(),
      hash,
      prefix,
      scopes: Array.isArray(data.scopes) && data.scopes.length > 0 ? data.scopes : DEFAULT_SCOPES,
      agentId: data.agentId || null,
      createdBy: this.caller.uid || 'system',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };

    await db.collection('api_keys').doc(keyId).set(cleanUndefined(record));

    // The full key (with the plaintext secret) is returned exactly once —
    // it is never stored, only its hash is.
    return {
      id: keyId,
      prefix,
      name: record.name,
      scopes: record.scopes,
      createdAt: record.createdAt,
      fullKey,
    };
  }
}
