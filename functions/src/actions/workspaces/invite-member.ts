import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class InviteMemberAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('workspaces.inviteMember', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.email) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, email.');
    }

    const cleanEmail = data.email.trim().toLowerCase();
    const invId = `inv-${nanoid(8)}`;
    const role = data.role || 'member';

    const invitation = {
      id: invId,
      workspaceId: data.workspaceId,
      workspaceName: data.workspaceName || 'Workspace',
      email: cleanEmail,
      role,
      inviterId: this.caller.uid || data.inviterId || 'system',
      inviterName: data.inviterName || this.caller.email || 'Un miembro',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await db.collection('invitations').doc(invId).set(cleanUndefined(invitation));

    // Check if target user already registered in Firebase
    try {
      const qSnap = await db.collection('users').where('email', '==', cleanEmail).get();
      if (!qSnap.empty) {
        const userDoc = qSnap.docs[0].data();
        const memberId = `${data.workspaceId}_${userDoc.uid}`;
        await db.collection('members').doc(memberId).set(
          cleanUndefined({
            id: memberId,
            workspaceId: data.workspaceId,
            userId: userDoc.uid,
            email: userDoc.email,
            displayName: userDoc.displayName || cleanEmail,
            role,
            joinedAt: new Date().toISOString(),
          })
        );

        await db.collection('users').doc(userDoc.uid).update({
          workspaceIds: FieldValue.arrayUnion(data.workspaceId),
        });

        await db.collection('invitations').doc(invId).update({ status: 'accepted' });
      }
    } catch (err) {
      console.warn('Warning when checking existing user for invitation:', err);
    }

    return invitation;
  }
}
