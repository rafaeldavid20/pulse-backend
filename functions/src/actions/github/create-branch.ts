import { invalidateChangedApproval } from '../../common/utils/review-request';
import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { resolveIssueRepo } from '../../common/utils/repo-resolution';
import {
  allowedReposForIssue,
  assertRepoAllowed,
  upsertGitRef,
} from '../../common/utils/project-repos';
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
    // Dos límites, no uno: la instalación dice a qué repos llega la App, y el
    // proyecto dice en cuáles se puede trabajar este issue. El segundo es el que
    // el usuario controla desde Pulse.
    const allowed = await allowedReposForIssue(db, issue, repos.map((r) => r.fullName));
    assertRepoAllowed(repoFullName, allowed, `el proyecto de ${issue.identifier}`);

    const branch = data.branch || suggestedBranchName(issue.identifier, issue.title);
    const result = await createGithubBranch(installation.installationId, repoFullName, branch, data.baseBranch);

    const now = new Date().toISOString();
    const ref = {
      repoFullName: result.repoFullName,
      branch: result.branch,
      branchUrl: result.branchUrl,
      baseBranch: result.baseBranch,
      lastSyncedAt: now,
    };

    // GitHub can take long enough for QA or another branch update to finish.
    // Re-read in a transaction so the new reference and approval invalidation
    // are based on the same current issue, not the pre-network snapshot.
    const nextRefs = await db.runTransaction(async tx => {
      const current = (await tx.get(issueRef)).data();
      if (!current || current.workspaceId !== issue.workspaceId || current.projectId !== issue.projectId) {
        throw new Error('La issue cambió de workspace o proyecto durante la creación de la rama.');
      }
      const refs = upsertGitRef(current.gitRefs || (current.git?.repoFullName ? [current.git] : []), ref);
      const updates: Record<string, any> = {
        gitRefs: refs, ...invalidateChangedApproval(current, refs, now), updatedAt: now,
      };
      const isPrimaryRepo = !current.git?.repoFullName || current.git.repoFullName === result.repoFullName;
      if (isPrimaryRepo) {
        updates['git.repoFullName'] = result.repoFullName;
        updates['git.branch'] = result.branch;
        updates['git.branchUrl'] = result.branchUrl;
        updates['git.baseBranch'] = result.baseBranch;
        updates['git.lastSyncedAt'] = now;
      }
      tx.update(issueRef, updates);
      return refs;
    });
    return { issueId: data.issueId, ...result, gitRefs: nextRefs };
  }
}
