import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { profileInput } from '../../common/utils/runner-profile-contract';
import { manageRunnerProfile } from '../../runners/profiles';

export class RunnerProfileAction extends PlatformActionHandler {
  private valid: boolean;
  private input: unknown;
  constructor(request: PlatformActionRequest, uid?: string, email?: string) {
    const parsed = profileInput.safeParse(request.data);
    // Reject unsafe input before the generic action audit can persist it.
    // Do not reuse generic actionID caching: every read must authorize afresh.
    super('runners.profile', { actionCode: 'runners.profile', data: parsed.success ? { agentId: parsed.data.agentId, runnerId: parsed.data.runnerId, op: parsed.data.op, ...(parsed.data.requestId ? { requestId: parsed.data.requestId } : {}) } : {} }, uid, email);
    this.valid = parsed.success;
    this.input = parsed.success ? parsed.data : null;
  }
  protected async authorize() { return !!this.caller.uid && this.valid; }
  protected auditResponse() { return { recorded: true }; }
  protected async handleAction() { return manageRunnerProfile(getFirestore(), this.caller.uid!, this.input); }
}
