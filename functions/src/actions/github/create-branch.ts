import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { suggestedBranchName } from '../../common/utils/slug';
import { createBranch as createGithubBranch } from '../../github/client';

export class CreateBranchAction extends PlatformActionHandler {
  private issueId?: string;
  private resolvedWorkspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('github.createBranch', request, callerUid, callerEmail);
    this.issueId = request.data?.issueId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.issueId) return false;
    const snap = await getFirestore().collection('issues').doc(this.issueId).get();
    if (!snap.exists) return false;
    this.resolvedWorkspaceId = snap.data()!.workspaceId;
    return this.isWorkspaceMember(this.resolvedWorkspaceId!);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.issueId) {
      throw new Error('Parámetro requerido faltante: issueId.');
    }

    const issueRef = db.collection('issues').doc(data.issueId);
    const issueSnap = await issueRef.get();
    if (!issueSnap.exists) {
      throw new Error(`El issue con ID '${data.issueId}' no existe.`);
    }
    const issue = issueSnap.data()!;

    const installSnap = await db
      .collection('github_installations')
      .where('workspaceId', '==', issue.workspaceId)
      .limit(1)
      .get();
    if (installSnap.empty) {
      throw new Error('Este workspace no tiene GitHub conectado todavía (Settings → GitHub).');
    }
    const installation = installSnap.docs[0].data();
    const repos: Array<{ fullName: string }> = installation.repositories || [];

    let repoFullName: string | undefined = data.repoFullName;
    if (!repoFullName && this.caller.uid) {
      const agentSnap = await db.collection('agents').doc(this.caller.uid).get();
      repoFullName = agentSnap.exists ? agentSnap.data()!.defaultRepo : undefined;
    }
    if (!repoFullName && repos.length === 1) {
      repoFullName = repos[0].fullName;
    }
    if (!repoFullName) {
      throw new Error(
        `Especificá repoFullName — la instalación de GitHub tiene ${repos.length} repos (${repos
          .map((r) => r.fullName)
          .join(', ')}) y no hay uno por defecto.`
      );
    }
    if (!repos.some((r) => r.fullName === repoFullName)) {
      throw new Error(`'${repoFullName}' no está entre los repos autorizados para esta instalación.`);
    }

    const branch = data.branch || suggestedBranchName(issue.identifier, issue.title);
    const result = await createGithubBranch(installation.installationId, repoFullName, branch, data.baseBranch);

    const now = new Date().toISOString();
    await issueRef.update({
      'git.repoFullName': result.repoFullName,
      'git.branch': result.branch,
      'git.branchUrl': result.branchUrl,
      'git.baseBranch': result.baseBranch,
      'git.lastSyncedAt': now,
      updatedAt: now,
    });

    return { issueId: data.issueId, ...result };
  }
}
