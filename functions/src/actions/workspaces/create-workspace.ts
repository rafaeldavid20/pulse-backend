import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';

export class CreateWorkspaceAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('workspaces.create', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const userId = this.caller.uid || data.userId;
    const userEmail = this.caller.email || data.userEmail;
    const userName = data.userName || userEmail || 'Usuario';
    const workspaceName = data.name || 'Nuevo Workspace';

    if (!userId) {
      throw new Error('Identificador de usuario (userId) es obligatorio.');
    }

    const wsId = `ws-${nanoid(8)}`;
    const slug = workspaceName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');

    const workspace = {
      id: wsId,
      name: workspaceName,
      slug,
      ownerId: userId,
      createdAt: new Date().toISOString(),
    };

    await db.collection('workspaces').doc(wsId).set(cleanUndefined(workspace));

    // Update user profile document
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (userSnap.exists) {
      await userRef.update({
        workspaceIds: FieldValue.arrayUnion(wsId),
      });
    } else {
      await userRef.set(
        cleanUndefined({
          uid: userId,
          email: userEmail,
          displayName: userName,
          workspaceIds: [wsId],
          createdAt: new Date().toISOString(),
        })
      );
    }

    // Create owner member record
    const memberId = `${wsId}_${userId}`;
    const member = {
      id: memberId,
      workspaceId: wsId,
      userId,
      email: userEmail,
      displayName: userName,
      role: 'owner',
      joinedAt: new Date().toISOString(),
    };
    await db.collection('members').doc(memberId).set(cleanUndefined(member));

    // Create default team
    const wsKey = workspaceName.trim().substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'W') || 'PUL';
    const teamId = `team-${nanoid(8)}`;
    const team = {
      id: teamId,
      workspaceId: wsId,
      name: workspaceName || 'Orden y Progreso',
      key: wsKey,
      icon: '⚡',
      issueCount: 0,
      createdAt: new Date().toISOString(),
    };
    await db.collection('teams').doc(teamId).set(cleanUndefined(team));

    return { workspace, team };
  }
}
