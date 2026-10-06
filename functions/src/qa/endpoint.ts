import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { authenticateRequest } from '../mcp/auth';
import { findIssue } from '../mcp/tools/read';
import { githubAppId, githubAppPrivateKeyB64, mcpKeyPepper } from '../common/secrets';
import { qaArchive, qaProjectRepos, resolveQaRepo, withQaRepo } from './source';

/** Transport for trusted preparation only: no GitHub identity leaves the server. */
export const pulseQaSource = onRequest({ region: 'us-east4', timeoutSeconds: 540, memory: '512MiB', secrets: [githubAppId, githubAppPrivateKeyB64, mcpKeyPepper] }, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }
  try {
    const principal = await authenticateRequest(req.headers.authorization);
    if (!principal.agentId || !principal.scopes.includes('reviews:read')) throw new Error('Identidad QA requerida.');
    const db = getFirestore();
    const agent = (await db.collection('agents').doc(principal.agentId).get()).data();
    if (agent?.workspaceId !== principal.workspaceId || agent?.role !== 'qa' || !agent.enabled) throw new Error('Agente QA no habilitado.');
    const issueDoc = await findIssue(principal.workspaceId, String(req.body?.identifier || ''));
    if (!issueDoc || (principal.issueId && principal.issueId !== issueDoc.id)) throw new Error('Issue fuera del alcance del job.');
    const issue = issueDoc.data()!;
    if (issue.status !== 'in_review') throw new Error('El issue no está esperando revisión.');
    if (issue.review?.dispatchedTo !== principal.agentId && issue.review?.claimedBy !== principal.agentId) throw new Error('Revisión no asignada a esta identidad.');
    if (principal.jobId) {
      const job = (await db.collection('runner_jobs').doc(principal.jobId).get()).data();
      const runner = (await db.collection('runners').doc(principal.runnerId!).get()).data();
      if (job?.status !== 'delivered' || job.mode !== 'review' || job.cancelRequestedAt || Date.parse(job.expiresAt) <= Date.now() || runner?.revokedAt) throw new Error('Job de revisión revocado.');
    }
    const refs = (issue.gitRefs?.length ? issue.gitRefs : [issue.git]).filter((ref: any) => ref?.prNumber);
    const project = issue.projectId ? (await db.collection('projects').doc(issue.projectId).get()).data() : null;
    const repos = qaProjectRepos(project, principal.workspaceId, refs);
    if (principal.repoFullNames && (repos.some((repo) => !principal.repoFullNames!.includes(repo)) || principal.repoFullNames.some((repo) => !repos.includes(repo)))) throw new Error('El proyecto cambió desde el dispatch; repetí el run.');
    const proofRef = db.collection('qa_source_preflights').doc(`${issueDoc.id}_${principal.agentId}`);
    const installations = await db.collection('github_installations').where('workspaceId', '==', principal.workspaceId).get();
    const installationFor = (repo: string) => installations.docs.map((doc) => doc.data()).find((install) => !install.suspendedAt && install.repositoryFullNames?.includes(repo));
    const problems: Array<{ repo: string; message: string }> = [];
    const snapshots = [];
    if (req.body?.repo && !repos.includes(req.body.repo)) throw new Error('Repositorio fuera del proyecto.');
    for (const repo of req.body?.repo ? [req.body.repo as string] : repos) {
      try {
        const install = installationFor(repo);
        if (!install) throw new Error(`${repo}: falta acceso de la instalación GitHub del workspace.`);
        const snapshot = await withQaRepo(install.installationId, repo, async (get) => {
          const snapshot = await resolveQaRepo(repo, refs.find((ref: any) => ref.repoFullName === repo), get);
          if (req.body?.repo && snapshot.sha !== req.body.sha) throw new Error(`${repo}: el head cambió; repetí el preflight.`);
          const archive = await qaArchive(get, snapshot.sha);
          return { snapshot, archive };
        });
        if (req.body?.repo) {
          const proof = (await proofRef.get()).data();
          if (!proof || proof.projectId !== issue.projectId || !proof.repositories.some((entry: any) => entry.repo === repo && entry.sha === snapshot.snapshot.sha)) throw new Error(`${repo}: repetí el preflight completo.`);
          await proofRef.set({ downloaded: { [repo]: snapshot.snapshot.sha } }, { merge: true });
          res.type('application/zip').send(snapshot.archive);
          return;
        }
        snapshots.push(snapshot.snapshot);
      } catch (error) { problems.push({ repo, message: (error as Error).message }); }
    }
    if (problems.length) { res.status(409).json({ category: 'qa_infrastructure', problems }); return; }
    await proofRef.set({ workspaceId: principal.workspaceId, projectId: issue.projectId, checkedAt: new Date().toISOString(), repositories: snapshots, downloaded: {} });
    res.json({ projectId: issue.projectId, repositories: snapshots });
  } catch (error) {
    // Provider response bodies/headers must never enter logs or issue comments.
    res.status(403).json({ category: 'qa_infrastructure', message: (error as Error).message });
  }
});
