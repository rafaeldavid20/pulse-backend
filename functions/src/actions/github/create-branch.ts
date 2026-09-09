import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
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

    // Misma cascada que usa el trigger de dispatch: explícito -> issue ->
    // épica -> agente -> instalación con un solo repo. Antes esto saltaba del
    // parámetro directo al `defaultRepo` del agente, sin mirar nunca el repo
    // del issue ni el de su épica.
    const { repoFullName } = await resolveIssueRepo(
      db,
      { ...issue, id: data.issueId },
      {
        explicitRepo: data.repoFullName,
        agentId: this.caller.uid,
        installationRepos: repos.map((r) => r.fullName),
      }
    );

    if (!repoFullName) {
      throw new Error(
        `Especificá repoFullName — la instalación de GitHub tiene ${repos.length} repos (${repos
          .map((r) => r.fullName)
          .join(', ')}), y ni el issue, ni su épica, ni el agente tienen uno por defecto.`
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
