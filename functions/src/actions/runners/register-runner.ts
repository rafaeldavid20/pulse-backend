import { randomBytes } from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { Runner } from '../../common/domain.generated';
import { hashApiKeySecret } from '../../common/utils/api-key';
import { cleanUndefined } from '../../common/utils/clean';
import { mcpKeyPepper } from '../../common/secrets';

function createDeviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Pairs a local Runner with its owner. The returned credential is shown once. */
export class RegisterRunnerAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.register', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    return !!this.workspaceId && this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { workspaceId, displayName, publicKey, connectedRepos, maxConcurrentJobs } = this.action.data;
    if (!workspaceId || !String(displayName || '').trim() || !String(publicKey || '').trim()) {
      throw new Error('workspaceId, displayName y publicKey son obligatorios para registrar un Runner.');
    }
    if (!Array.isArray(connectedRepos) || connectedRepos.some((repo) => typeof repo !== 'string')) {
      throw new Error('connectedRepos debe ser una lista de repositorios.');
    }
    const now = new Date().toISOString();
    const runner: Runner = {
      id: `runner-${nanoid(12)}`,
      workspaceId,
      ownerMemberId: this.caller.uid!,
      displayName: String(displayName).trim(),
      publicKey: String(publicKey).trim(),
      status: 'offline',
      maxConcurrentJobs: Number.isInteger(maxConcurrentJobs) && maxConcurrentJobs > 0 ? maxConcurrentJobs : 1,
      connectedRepos: Array.from(new Set(connectedRepos)),
      createdAt: now,
      updatedAt: now,
    };
    const deviceSecret = createDeviceSecret();
    await getFirestore().collection('runners').doc(runner.id).set(cleanUndefined({
      ...runner,
      deviceSecretHash: hashApiKeySecret(deviceSecret, mcpKeyPepper.value()),
    }));
    return { runner, deviceCredential: `${runner.id}.${deviceSecret}` };
  }

  protected auditResponse(response: Record<string, any>): Record<string, any> {
    const { deviceCredential: _secret, ...safe } = response;
    return safe;
  }
}
