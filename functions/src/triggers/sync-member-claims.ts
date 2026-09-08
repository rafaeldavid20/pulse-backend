import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

/**
 * Keeps each real user's Firebase custom claims (`{ ws: { [workspaceId]:
 * role } }`) in sync with their `members` docs, so Firestore rules can check
 * `request.auth.token.ws[workspaceId]` instead of a `get()` per document —
 * rules cap at 10 `get()`s per request, custom claims cost nothing to read.
 *
 * Re-reads *all* of the user's current memberships on every write (not just
 * the one that triggered this) so a removal is reflected correctly too, not
 * just an add/update.
 *
 * Skips agent members entirely: an agent's `userId` (e.g. `agent-claude`) is
 * not a real Firebase Auth uid — it never signs in, so `setCustomUserClaims`
 * would just throw "no user record found" for it.
 */
export const syncMemberClaimsTrigger = onDocumentWritten(
  {
    document: 'members/{memberId}',
    region: 'us-east4',
  },
  async (event) => {
    try {
      const before = event.data?.before.data();
      const after = event.data?.after.data();
      const member = after ?? before;
      if (!member) return;

      if (before?.isAgent || after?.isAgent) return;

      const userId: string | undefined = member.userId;
      if (!userId) return;

      const db = getFirestore();
      const snap = await db.collection('members').where('userId', '==', userId).get();

      const ws: Record<string, string> = {};
      for (const doc of snap.docs) {
        const data = doc.data();
        if (data.isAgent) continue;
        if (data.workspaceId && data.role) ws[data.workspaceId] = data.role;
      }

      await getAuth().setCustomUserClaims(userId, { ws });
      console.log(`[SyncMemberClaims] set claims for '${userId}': ${Object.keys(ws).length} workspace(s).`);
    } catch (error) {
      console.error('[SyncMemberClaims] error handling member write, will not retry:', error);
    }
  }
);
