import { getFirestore } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { findIssue } from '../../mcp/tools/read';
import { identifierFromBranch, identifierFromClosesKeyword } from '../../common/utils/issue-refs';

interface WebhookSyncInput {
  event: 'create' | 'pull_request';
  repoFullName: string;
  branch: string;
  prAction?: string;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  merged?: boolean;
  draft?: boolean;
}

/**
 * The GitHub webhook's only job after signature verification: figure out
 * which issue (if any) a push/PR event is about, and apply the matching
 * status transition — without a human caller, so it runs `isFromSystem`
 * (see PlatformActionHandler's default `authorize()`). The webhook handler
 * is what actually gates this: it never reaches dispatch without a verified
 * HMAC signature.
 */
export class SyncFromWebhookAction extends PlatformActionHandler {
  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.syncFromWebhook', request, callerUid, callerEmail);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const input = this.action.data as WebhookSyncInput;

    if (!input.repoFullName || !input.branch || !input.event) {
      throw new Error('Parámetros requeridos faltantes: event, repoFullName, branch.');
    }

    const installSnap = await db
      .collection('github_installations')
      .where('repositoryFullNames', 'array-contains', input.repoFullName)
      .limit(1)
      .get();
    if (installSnap.empty) {
      return { matched: false, reason: 'no_installation_for_repo' };
    }
    const workspaceId = installSnap.docs[0].data().workspaceId as string;

    const issueDoc = await this.resolveIssue(workspaceId, input);
    if (!issueDoc) {
      return { matched: false, reason: 'no_matching_issue' };
    }
    const issue = issueDoc.data()!;

    const desiredStatus = this.desiredStatus(input, issue.status);

    // Manual-override guard: if a human moved the status away from the
    // status *we* last set via sync, a webhook event shouldn't silently
    // pull it back — that's how "I moved it back to todo because the PR
    // needs rework" gets undone by the next push event.
    const overriddenManually =
      desiredStatus && issue.git?.lastSyncedStatus && issue.status !== issue.git.lastSyncedStatus;

    const now = new Date().toISOString();
    const updates: Record<string, any> = {
      'git.repoFullName': input.repoFullName,
      'git.branch': input.branch,
      'git.lastSyncedAt': now,
      updatedAt: now,
    };
    if (input.prNumber !== undefined) updates['git.prNumber'] = input.prNumber;
    if (input.prUrl !== undefined) updates['git.prUrl'] = input.prUrl;
    if (input.event === 'pull_request') {
      updates['git.prState'] = input.merged ? 'merged' : input.draft ? 'draft' : this.prStateFor(input.prAction);
    }

    let statusChanged = false;
    if (desiredStatus && !overriddenManually && desiredStatus !== issue.status) {
      updates.status = desiredStatus;
      updates['git.lastSyncedStatus'] = desiredStatus;
      if (desiredStatus === 'done') {
        updates['agent.state'] = 'idle';
      }
      statusChanged = true;
    }

    await issueDoc.ref.update(updates);

    if (statusChanged) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)} → estado actualizado a \`${desiredStatus}\`.`
      );
    } else if (overriddenManually) {
      await this.postComment(
        db,
        workspaceId,
        issueDoc.id,
        `GitHub: ${this.describeEvent(input)}, pero el estado se dejó sin tocar porque alguien lo cambió manualmente después del último sync.`
      );
    }

    return { matched: true, issueId: issueDoc.id, statusChanged, newStatus: statusChanged ? desiredStatus : issue.status };
  }

  private async resolveIssue(workspaceId: string, input: WebhookSyncInput) {
    const db = getFirestore();

    // Level 1: the issue already links to this exact repo+branch.
    const byGitFields = await db
      .collection('issues')
      .where('workspaceId', '==', workspaceId)
      .where('git.repoFullName', '==', input.repoFullName)
      .where('git.branch', '==', input.branch)
      .limit(1)
      .get();
    if (!byGitFields.empty) return byGitFields.docs[0];

    // Level 2: branch naming convention (pul/eng-142-slug).
    const fromBranch = identifierFromBranch(input.branch);
    if (fromBranch) {
      const doc = await findIssue(workspaceId, fromBranch);
      if (doc) return doc;
    }

    // Level 3: "Closes ENG-142" in the PR title/body.
    if (input.event === 'pull_request') {
      const fromText = identifierFromClosesKeyword(`${input.prTitle || ''}\n${input.prBody || ''}`);
      if (fromText) {
        const doc = await findIssue(workspaceId, fromText);
        if (doc) return doc;
      }
    }

    return null;
  }

  private desiredStatus(input: WebhookSyncInput, currentStatus: string): string | null {
    if (input.event === 'create') {
      return currentStatus === 'todo' ? 'in_progress' : null;
    }
    // pull_request
    if (['opened', 'reopened', 'ready_for_review'].includes(input.prAction || '')) {
      return input.draft ? 'in_progress' : 'in_review';
    }
    if (input.prAction === 'closed') {
      return input.merged ? 'done' : 'in_progress';
    }
    return null;
  }

  private prStateFor(prAction?: string): 'open' | 'closed' {
    return prAction === 'closed' ? 'closed' : 'open';
  }

  private describeEvent(input: WebhookSyncInput): string {
    if (input.event === 'create') return `se creó la rama \`${input.branch}\``;
    if (input.prAction === 'closed' && input.merged) return `el PR #${input.prNumber} se mergeó`;
    if (input.prAction === 'closed') return `el PR #${input.prNumber} se cerró sin mergear`;
    return `el PR #${input.prNumber} pasó a "${input.prAction}"`;
  }

  private async postComment(db: FirebaseFirestore.Firestore, workspaceId: string, issueId: string, body: string) {
    const commentId = `cmt-${nanoid(8)}`;
    await db.collection('comments').doc(commentId).set({
      id: commentId,
      workspaceId,
      issueId,
      authorId: 'github',
      body,
      source: 'github',
      createdAt: new Date().toISOString(),
    });
  }
}
