import { getFirestore, Timestamp, DocumentReference } from 'firebase-admin/firestore';
import {
  PlatformAction,
  PlatformActionCode,
  PlatformActionCaller,
  PlatformActionRequest,
  PlatformActionResponse,
} from './interfaces';
import { cleanUndefined } from '../utils/clean';

export abstract class PlatformActionHandler {
  protected actionCode: PlatformActionCode;
  protected caller: PlatformActionCaller;
  protected action: PlatformAction;
  protected actionDR: DocumentReference;
  protected force: boolean;

  constructor(
    actionCode: PlatformActionCode,
    request: PlatformActionRequest,
    callerUid?: string,
    callerEmail?: string
  ) {
    const db = getFirestore();
    const actionsCR = db.collection('platform_actions');

    this.actionCode = actionCode;
    this.actionDR = request.actionID ? actionsCR.doc(request.actionID) : actionsCR.doc();
    this.force = request.force ?? false;

    this.caller = {
      uid: callerUid,
      email: callerEmail,
      isFromSystem: !callerUid,
    };

    this.action = {
      actionID: this.actionDR.id,
      actionCode,
      caller: this.caller,
      createdTime: Timestamp.now(),
      data: request.data || {},
      status: 'in_progress',
    };
  }

  /**
   * Authorization check — override in subclass to enforce custom permission
   * rules. The default requires a real authenticated caller: it deliberately
   * does NOT grant access via `isFromSystem`. `isFromSystem` is `!callerUid`
   * (handler.ts constructor), which means a raw unauthenticated HTTP call to
   * the `pulsePlatformAction` callable (no Firebase ID token, so
   * `request.auth` is empty) looks exactly like a legitimate internal
   * "system" caller. Any action that genuinely needs to run without a human
   * caller (currently only `github.syncFromWebhook`, gated by the webhook's
   * own HMAC signature check before it ever reaches the dispatcher) must
   * override this and check `this.caller.isFromSystem` itself — that's an
   * explicit opt-in per action instead of an implicit grant for every action
   * that forgets to override this method.
   */
  protected async authorize(): Promise<boolean> {
    return !!this.caller.uid;
  }

  /**
   * Checks whether the current caller is a member of the given workspace, by
   * looking up the `members/{workspaceId}_{uid}` doc (the id convention used
   * everywhere a member is created — see create-workspace.ts,
   * invite-member.ts). Returns false for callers with no uid.
   */
  protected async isWorkspaceMember(workspaceId: string): Promise<boolean> {
    if (!this.caller.uid) return false;
    const db = getFirestore();
    const memberSnap = await db.collection('members').doc(`${workspaceId}_${this.caller.uid}`).get();
    return memberSnap.exists;
  }

  /**
   * Like `isWorkspaceMember`, but additionally requires the member's `role`
   * to be `minRole` or higher (`admin` and `owner` both satisfy `minRole:
   * 'admin'`; only `owner` satisfies `minRole: 'owner'`). Use this for
   * actions with real privilege implications — e.g. inviting a new member —
   * where "any member" isn't a tight enough check.
   */
  protected async assertWorkspaceMember(workspaceId: string, minRole?: 'admin' | 'owner'): Promise<boolean> {
    if (!this.caller.uid) return false;
    const db = getFirestore();
    const memberSnap = await db.collection('members').doc(`${workspaceId}_${this.caller.uid}`).get();
    if (!memberSnap.exists) return false;
    if (!minRole) return true;
    const role = memberSnap.data()!.role;
    if (minRole === 'owner') return role === 'owner';
    return role === 'owner' || role === 'admin';
  }

  /**
   * Abstract core execution method implemented by each specific Platform Action
   */
  protected abstract handleAction(): Promise<Record<string, any>>;

  /**
   * Main template method executing the action, handling status transitions & persistence
   */
  async run(): Promise<PlatformActionResponse> {
    try {
      console.log(`[PlatformAction] Starting action '${this.actionCode}' (ID: ${this.action.actionID})`);

      // Idempotency check: if action already completed and not forced, return cached result
      const existingSnap = await this.actionDR.get();
      if (existingSnap.exists && !this.force) {
        const existingData = existingSnap.data() as PlatformAction;
        if (existingData.status === 'completed') {
          console.log(`[PlatformAction] Action '${this.actionCode}' already executed. Returning cached response.`);
          return {
            success: true,
            isReexecution: true,
            data: existingData.response,
          };
        }
      }

      // Check authorization
      const isAuthorized = await this.authorize();
      if (!isAuthorized) {
        const failReason = 'Usuario no autorizado para ejecutar esta acción de plataforma.';
        await this.actionDR.set(
          cleanUndefined({
            ...this.action,
            status: 'failed',
            failedTime: Timestamp.now(),
            failedReason: failReason,
          })
        );
        return { success: false, error: failReason };
      }

      // Persist 'in_progress' state
      await this.actionDR.set(cleanUndefined(this.action), { merge: true });

      // Execute action
      const responseData = await this.handleAction();

      // Update state to 'completed'
      const completedAction: PlatformAction = {
        ...this.action,
        status: 'completed',
        completedTime: Timestamp.now(),
        response: responseData,
      };

      await this.actionDR.set(cleanUndefined(completedAction), { merge: true });

      console.log(`[PlatformAction] Action '${this.actionCode}' completed successfully.`);
      return {
        success: true,
        data: responseData,
      };
    } catch (error: any) {
      console.error(`[PlatformAction] Error executing '${this.actionCode}':`, error);
      const errorMessage = error?.message || 'Error interno al ejecutar la acción de plataforma.';

      await this.actionDR.set(
        cleanUndefined({
          ...this.action,
          status: 'failed',
          failedTime: Timestamp.now(),
          failedReason: errorMessage,
        }),
        { merge: true }
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
