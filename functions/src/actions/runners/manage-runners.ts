import { randomBytes } from 'crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { hashApiKeySecret } from '../../common/utils/api-key';
import { getWorkspaceMember, isWorkspaceAdmin } from '../../common/utils/agent-authorization';
import { mcpKeyPepper } from '../../common/secrets';

function deviceSecret(): string {
  return randomBytes(32).toString('base64url');
}

abstract class RunnerWorkspaceAction extends PlatformActionHandler {
  protected runnerId?: string;
  protected workspaceId?: string;

  constructor(actionCode: 'runners.list' | 'runners.revoke' | 'runners.rotateCredential', request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super(actionCode, request, callerUid, callerEmail);
    this.runnerId = request.data?.runnerId;
    this.workspaceId = request.data?.workspaceId;
  }

  protected async runnerAndCaller() {
    const db = getFirestore();
    if (!this.runnerId) throw new Error('runnerId es obligatorio.');
    const snap = await db.collection('runners').doc(this.runnerId).get();
    if (!snap.exists) throw new Error('El Runner no existe.');
    const runner = snap.data()!;
    const caller = await getWorkspaceMember(db, runner.workspaceId, this.caller.uid!);
    return { db, runner, caller };
  }
}

export class ListRunnersAction extends RunnerWorkspaceAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.list', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    return !!this.workspaceId && this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const caller = await getWorkspaceMember(db, this.workspaceId!, this.caller.uid!);
    const snap = await db.collection('runners').where('workspaceId', '==', this.workspaceId).get();
    const runners = snap.docs
      .map((doc) => doc.data())
      .filter((runner) => isWorkspaceAdmin(caller) || runner.ownerMemberId === this.caller.uid)
      .map(({ deviceSecretHash: _secret, ...runner }) => runner);
    return { runners };
  }
}

export class RevokeRunnerAction extends RunnerWorkspaceAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.revoke', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    if (!this.runnerId) return false;
    const snap = await getFirestore().collection('runners').doc(this.runnerId).get();
    if (!snap.exists) return false;
    this.workspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { db, runner, caller } = await this.runnerAndCaller();
    if (runner.ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(caller)) throw new Error('Solo el dueño o un admin puede revocar este Runner.');
    const now = new Date().toISOString();
    await db.collection('runners').doc(this.runnerId!).update({ status: 'offline', revokedAt: now, deviceSecretHash: null, updatedAt: now });
    return { runnerId: this.runnerId, revokedAt: now };
  }
}

export class RotateRunnerCredentialAction extends RunnerWorkspaceAction {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('runners.rotateCredential', request, callerUid, callerEmail);
  }

  protected async authorize(): Promise<boolean> {
    if (!this.runnerId) return false;
    const snap = await getFirestore().collection('runners').doc(this.runnerId).get();
    if (!snap.exists) return false;
    this.workspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.workspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const { db, runner, caller } = await this.runnerAndCaller();
    if (runner.ownerMemberId !== this.caller.uid && !isWorkspaceAdmin(caller)) throw new Error('Solo el dueño o un admin puede rotar esta credencial.');
    const secret = deviceSecret();
    const now = new Date().toISOString();
    await db.collection('runners').doc(this.runnerId!).update({
      deviceSecretHash: hashApiKeySecret(secret, mcpKeyPepper.value()), revokedAt: null, status: 'offline', updatedAt: now,
    });
    return { runnerId: this.runnerId, deviceCredential: `${this.runnerId}.${secret}` };
  }

  protected auditResponse(response: Record<string, any>): Record<string, any> {
    const { deviceCredential: _secret, ...safe } = response;
    return safe;
  }
}
