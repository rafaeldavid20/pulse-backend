import { runnerPreflight } from '../common/utils/runner-preflight';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, Transaction, FieldValue } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { githubAppId, githubAppPrivateKeyB64, runnerJobSigningPrivateKey } from '../common/secrets';
import { dispatchRepositoryEvent, getPullRequestOrigin } from '../github/client';
import { resolveIssueRepo } from '../common/utils/repo-resolution';
import { checkWorkspaceDispatchBudget, todayKey } from '../common/utils/dispatch-counter';
import { checkIssueRunBudget } from '../common/utils/issue-run-budget';
import { buildNeedsHumanEscalation } from '../common/utils/review-escalation';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { qaAssignmentError } from '../common/utils/qa-assignment';
import { isRunnerAvailable } from '../common/utils/runner-availability';

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

// Mismo hueco que TES-130 pero del lado de QA: el workflow de revisión tarda
// en arrancar y reclamar (`review.claimedBy`, D5), así que un guard que solo
// mire el estado actual del issue no alcanza para separar dos disparos que
// ocurren antes de que cualquiera llegue a reclamar.
const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

async function assertRunnerCapacity(db: FirebaseFirestore.Firestore, runnerId: string, maxConcurrentJobs: number) {
  const jobs = await db.collection('runner_jobs').where('runnerId', '==', runnerId).get();
  const now = Date.now();
  const active = jobs.docs.filter((doc) => {
    const job = doc.data();
    if (!['pending', 'delivered'].includes(job.status)) return false;
    const expiresAt = new Date(job.expiresAt).getTime();
    return !Number.isFinite(expiresAt) || expiresAt > now;
  }).length;
  if (active >= maxConcurrentJobs) throw new Error('Runner reached its active job limit.');
}

interface ReviewablePr {
  repoFullName: string;
  prNumber: number;
  branch?: string;
}

/**
 * Los PRs del issue, si el conjunto está en condiciones de revisarse: cada
 * rama tiene PR, ninguno quedó en draft ni cerrado sin mergear, y no queda
 * ningún traspaso a otro repo sin cerrar (K9/TES-202) — lo mismo que exige
 * `statusFromGitRefs` para dejar entrar el issue a `in_review`, revalidado acá
 * por si algo más lo empujó a este estado.
 *
 * Un PR **ya mergeado no impide revisar el resto** (TES-274). Antes se exigía
 * que todos estuvieran abiertos, y eso dejaba sin revisión a cualquier issue
 * multi-repo cuyos PRs no coincidieran abiertos al mismo tiempo. El diff de un
 * PR mergeado sigue siendo legible y sigue siendo parte del trabajo del issue,
 * así que entra en el contexto de la revisión como cualquier otro.
 *
 * `null` cuando el conjunto no es revisable todavía.
 */
function reviewablePrs(issue: FirebaseFirestore.DocumentData): ReviewablePr[] | null {
  if ((issue.pendingRepoWork || []).length > 0) return null;

  const refs: any[] =
    Array.isArray(issue.gitRefs) && issue.gitRefs.length > 0
      ? issue.gitRefs
      : issue.git?.repoFullName
        ? [issue.git]
        : [];

  if (refs.length === 0) return null;
  if (!refs.every((r) => r?.prNumber !== undefined)) return null;
  if (refs.some((r) => r.prState === 'draft' || r.prState === 'closed')) return null;
  // Todos mergeados es un issue cerrado, no uno para revisar.
  if (refs.every((r) => r.prState === 'merged')) return null;

  return refs.map((r) => ({ repoFullName: r.repoFullName, prNumber: r.prNumber, branch: r.branch }));
}

/**
 * Fase 6/D4's QA trigger, gemelo de `agent-dispatch.ts`: dispara cuando un
 * issue entra a `in_review` y no estaba antes, para que un agente `role: qa`
 * lo revise contra sus criterios de aceptación.
 *
 * Nunca lanza hacia arriba: un throw acá hace que Cloud Functions reintente
 * el dispatch, que es justo lo que el circuit breaker de abajo existe para
 * evitar.
 */
export const qaDispatchTrigger = onDocumentWritten(
  {
    document: 'issues/{issueId}',
    region: 'us-east4',
    secrets: [githubAppId, githubAppPrivateKeyB64, runnerJobSigningPrivateKey],
  },
  async (event) => {
    try {
      const before = event.data?.before.data();
      const after = event.data?.after.data();
      if (!after) return; // deleted

      const issueId = event.params.issueId;
      const enteredInReview = after.status === 'in_review' && before?.status !== 'in_review';
      if (!enteredInReview) return;

      const prs = reviewablePrs(after);
      if (!prs) {
        console.log(`[QaDispatch] issue '${issueId}' entró a 'in_review' pero sus PRs no están todos abiertos (o hay pendingRepoWork), skipping.`);
        return;
      }

      const db = getFirestore();
      const workspaceId = after.workspaceId;
      const issueRef = db.collection('issues').doc(issueId);
      const recordDispatchError = async (message: string) => {
        await db.runTransaction(async (tx) => {
          const current = await tx.get(issueRef);
          if (current.data()?.status !== 'in_review' || current.data()?.qaAssigneeId !== after.qaAssigneeId) return;
          tx.update(issueRef, { 'review.dispatchError': message, updatedAt: new Date().toISOString() });
        });
      };

      // Repo contra el que matchear `reviewRepo`: el del issue, o el de su
      // épica si el issue no tiene uno propio (cascada compartida con el
      // dispatch de dev).
      // TES-284 separa responsable humano de ejecutor. Los issues previos
      // conservan `assigneeId` como fallback, pero los nuevos resuelven el
      // repo desde el agente que realmente hizo el trabajo.
      const executionAgentId = after.execution?.agentId || after.assigneeId;
      const { repoFullName } = await resolveIssueRepo(db, { ...after, id: issueId }, { agentId: executionAgentId });
      if (!repoFullName) {
        await recordDispatchError('No se pudo resolver el repo del issue. Configurá su repositorio y volvé a despachar QA.');
        return;
      }

      const qaSnap = await db
        .collection('agents')
        .where('workspaceId', '==', workspaceId)
        .where('role', '==', 'qa')
        .where('enabled', '==', true)
        .where('autonomousMode', '==', true)
        .get();
      // Una selección manual prevalece aunque el QA no esté en modo autónomo.
      // Solo se usa la selección automática cuando el issue no tiene QA elegido.
      let qaDoc: FirebaseFirestore.DocumentSnapshot | undefined;
      if (after.qaAssigneeId) {
        const selected = await db.collection('agents').doc(after.qaAssigneeId).get();
        const agent = selected.data();
        const assignmentError = qaAssignmentError(selected.id, agent, workspaceId, executionAgentId, repoFullName);
        if (assignmentError) {
          await recordDispatchError(assignmentError);
          return;
        }
        qaDoc = selected;
      }
      // Actions revisa un repo configurado. Runner QA trabaja con snapshots
      // de todo el proyecto y por eso no necesita un reviewRepo por agente.
      // La elegibilidad Runner se termina de validar con runnerPreflight.
      const qaCandidates = qaSnap.docs.filter((d) => d.id !== executionAgentId && !d.data().archivedAt && (d.data().runnerId || d.data().reviewRepo === repoFullName));
      if (!qaDoc && qaCandidates.length === 0) {
        await recordDispatchError(`No hay QA autónomo habilitado para '${repoFullName}'. Asigná un agente QA manualmente y volvé a despachar.`);
        return;
      }
      const reviewRepos = [...new Set(prs.map((pr) => pr.repoFullName))];
      let runner: FirebaseFirestore.DocumentData | undefined;
      if (!qaDoc) {
        const runnerCandidates = qaCandidates.filter((item) => !!item.data().runnerId);
        for (const candidate of runnerCandidates) {
          const candidateRunnerSnap = await db.collection('runners').doc(candidate.data().runnerId).get();
          if (!candidateRunnerSnap.exists || candidateRunnerSnap.data()!.workspaceId !== workspaceId || !isRunnerAvailable(candidateRunnerSnap.data()!)) continue;
          const candidateRunner = candidateRunnerSnap.data()!;
          if (!runnerPreflight({ ...candidate.data(), id: candidate.id }, { ...candidateRunner, id: candidateRunnerSnap.id }, workspaceId, reviewRepos, 'review', Date.now(), true).ready) continue;
          try {
            await assertRunnerCapacity(db, candidateRunner.id, candidateRunner.maxConcurrentJobs || 1);
          } catch {
            continue;
          }
          qaDoc = candidate;
          runner = candidateRunner;
          break;
        }
        // No degradar silenciosamente a otro proveedor cuando hay QA Runner
        // configurado; Actions queda como compatibilidad sin QA Runner.
        if (!qaDoc && runnerCandidates.length === 0) qaDoc = qaCandidates.find((candidate) => !candidate.data().runnerId);
        if (!qaDoc && runnerCandidates.length > 0) {
          await recordDispatchError(`El QA Runner del proyecto no está disponible para '${repoFullName}'. Revisá su identidad, sesión y conexión, y volvé a despachar; no se enviará el issue a GitHub Actions.`);
          return;
        }
      }
      if (!qaDoc) {
        await recordDispatchError(`No hay QA con Runner disponible para '${repoFullName}'. Asigná un QA disponible y volvé a despachar.`);
        return;
      }
      const qaAgent = qaDoc.data();
      if (!qaAgent) return;
      const qaAgentId = qaDoc.id;
      const runnerId = qaAgent.runnerId as string | undefined;
      if (runnerId) {
        // `runner` se preparó al elegir el candidato y se revalida justo antes
        // de encolar para evitar enviar un job a un Runner que cambió de estado.
        const runnerSnap = await db.collection('runners').doc(runnerId).get();
        if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== workspaceId || !isRunnerAvailable(runnerSnap.data()!)) {
          await recordDispatchError('El Runner QA no está disponible o no cubre todos los repos. Corregí su configuración y volvé a despachar QA.');
          return;
        }
        runner = runnerSnap.data()!;
        const preflight = runnerPreflight({ ...qaAgent, id: qaAgentId }, { ...runner, id: runnerId }, workspaceId, reviewRepos, 'review', Date.now(), true);
        if (!preflight.ready) { await recordDispatchError(preflight.problems.map((problem) => `${problem.message} ${problem.action}`).join(' ')); return; }
        try {
          await assertRunnerCapacity(db, runnerId, runner.maxConcurrentJobs || 1);
        } catch {
          await recordDispatchError('El Runner QA alcanzó su límite de jobs activos. Volvé a despachar QA cuando tenga capacidad.');
          return;
        }
      }

      const review = after.review as Record<string, any> | undefined;
      const attempt = review?.attempt ?? 0;
      const maxReviewAttempts = qaAgent.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
      if (attempt >= maxReviewAttempts) {
        console.log(`[QaDispatch] issue '${issueId}' agotó los intentos de revisión (${attempt}/${maxReviewAttempts}), needs_human, skipping dispatch.`);
        if (review?.state !== 'needs_human') {
          await issueRef.update({ 'review.state': 'needs_human', updatedAt: new Date().toISOString() });
        }
        return;
      }

      // Tope de runs por issue (D8/TES-153): cuenta el TOTAL de runs (dev +
      // QA + traspasos), no solo los intentos de revisión — un issue puede
      // llegar acá con `attempt` bajo pero varios traspasos ya consumidos.
      const runBudget = await checkIssueRunBudget(db, workspaceId, issueId);
      if (!runBudget.withinBudget) {
        if (runBudget.reason === 'issue-run-limit') {
          console.log(
            `[QaDispatch] issue '${issueId}' alcanzó el tope de runs por issue (${runBudget.limit}), needs_human, skipping dispatch.`
          );
          const escalation = await buildNeedsHumanEscalation(db, after);
          await issueRef.update({ ...escalation, 'review.state': 'needs_human' });
        } else {
          console.log(
            `[QaDispatch] issue '${issueId}' alcanzó el techo de costo por issue (USD ${runBudget.capUsd}), skipping dispatch.`
          );
        }
        return;
      }

      const installSnap = await db
        .collection('github_installations')
        .where('workspaceId', '==', workspaceId)
        .limit(1)
        .get();
      if (installSnap.empty) {
        console.log(`[QaDispatch] workspace '${workspaceId}' has no GitHub installation, skipping dispatch.`);
        return;
      }
      const installation = installSnap.docs[0].data();

      // D18/TES-214: el repo es público, así que cualquiera puede abrir un PR
      // contra una rama con el nombre "correcto" en su propio fork, o el
      // webhook puede haber emparejado por convención de nombre un PR que no
      // es el que Pulse creó. Antes de gastar un dispatch se confirma en vivo
      // contra GitHub — nunca solo contra lo que ya quedó grabado en
      // `gitRefs` — que el HEAD de cada PR vive en este mismo repo (no un
      // fork) y en la rama que Pulse registró.
      const prOrigins = await Promise.all(
        prs.map((pr) => getPullRequestOrigin(installation.installationId, pr.repoFullName, pr.prNumber))
      );
      const untrustedPr = prs.find((pr, i) => {
        const origin = prOrigins[i];
        if (origin.headRepoFullName !== pr.repoFullName) return true; // fork, o el fork de origen se borró
        if (pr.branch && origin.headRef !== pr.branch) return true; // no es la rama que registró Pulse
        return false;
      });
      if (untrustedPr) {
        console.log(
          `[QaDispatch] issue '${issueId}' tiene un PR (${untrustedPr.repoFullName}#${untrustedPr.prNumber}) que no viene de una rama registrada en este mismo repo (posible fork), skipping dispatch.`
        );
        return;
      }

      // Anti-ping-pong: si ya hubo un intento cerrado y ningún PR tiene un
      // HEAD distinto del que vio esa revisión, el dev no pusheó nada nuevo y
      // no hay nada que re-revisar. Se compara contra `review.prs[].headSha`
      // del último veredicto usando el SHA recién leído arriba.
      const lastReviewedPrs: Array<{ repoFullName: string; prNumber: number; headSha: string }> = review?.prs || [];
      if (attempt >= 1 && lastReviewedPrs.length > 0) {
        const anyChanged = prs.some((pr, i) => {
          const last = lastReviewedPrs.find((p) => p.repoFullName === pr.repoFullName && p.prNumber === pr.prNumber);
          return !last || last.headSha !== prOrigins[i].headSha;
        });
        if (!anyChanged) {
          console.log(`[QaDispatch] issue '${issueId}' volvió a 'in_review' sin commits nuevos desde el último veredicto, skipping dispatch (anti-ping-pong).`);
          return;
        }
      }

      const dispatchDecision = await db.runTransaction(async (tx: Transaction) => {
        const issueSnap = await tx.get(issueRef);
        const dispatchedAt: string | undefined = issueSnap.data()?.review?.dispatchedAt;
        const dispatchedTo: string | undefined = issueSnap.data()?.review?.dispatchedTo;
        if (dispatchedTo === qaAgentId && dispatchedAt) {
          const elapsedMs = Date.now() - new Date(dispatchedAt).getTime();
          if (elapsedMs < DISPATCH_COOLDOWN_MS) {
            return { allowed: false, reason: 'recent-dispatch', elapsedMs } as const;
          }
        }

        const budget = await checkWorkspaceDispatchBudget(tx, db, workspaceId);
        if (!budget.allowed) return { allowed: false, reason: budget.reason } as const;

        tx.update(issueRef, {
          'review.dispatchError': FieldValue.delete(),
          'review.dispatchedAt': new Date().toISOString(),
          'review.dispatchedTo': qaAgentId,
        });
        return { allowed: true } as const;
      });
      if (!dispatchDecision.allowed) {
        if (dispatchDecision.reason === 'recent-dispatch') {
          console.log(
            `[QaDispatch] issue '${issueId}' ya despachado a QA '${qaAgentId}' ${Math.round(
              dispatchDecision.elapsedMs / 1000
            )}s atrás (cooldown ${DISPATCH_COOLDOWN_MS / 1000}s), skipping dispatch.`
          );
        } else {
          console.log(`[QaDispatch] dispatch blocked for workspace '${workspaceId}' (${dispatchDecision.reason}), skipping dispatch.`);
        }
        return;
      }

      const authorized: string[] = installation.repositoryFullNames || [];
      if (authorized.length > 0 && !authorized.includes(repoFullName)) {
        console.log(`[QaDispatch] '${repoFullName}' is not in this workspace's GitHub installation, skipping dispatch.`);
        return;
      }

      const nextAttempt = attempt + 1;
      const prNumber = prs.find((pr) => pr.repoFullName === repoFullName)?.prNumber;
      if (runnerId && runner) {
        const job = await enqueueRunnerJob(db, {
          workspaceId,
          issueId,
          agentId: qaAgentId,
          runnerId,
          repoFullName,
          contextRepos: (await db.collection('projects').doc(after.projectId).get()).data()?.repoFullNames || [],
          mode: 'review',
        }, runnerJobSigningPrivateKey.value());
        await db.collection('agent_runs').doc(job.id).set({
          id: job.id,
          issueId,
          workspaceId,
          agentId: qaAgentId,
          runnerId,
          role: 'qa',
          mode: 'review',
          repo: repoFullName,
          reviewAttempt: nextAttempt,
          startedAt: new Date().toISOString(),
          date: todayKey(),
        });
        console.log(`[QaDispatch] queued signed Runner review job '${job.id}' for issue '${after.identifier}' to QA '${qaAgentId}'.`);
      } else {
        // D15/TES-211: el runId se manda en el evento de GitHub para que el
        // workflow pulse-qa.yml complete el mismo registro vía runs.complete.
        const runId = `run-${nanoid(8)}`;
        await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_review', {
          issueId,
          issueIdentifier: after.identifier,
          workspaceId,
          agentId: qaAgentId,
          agentKind: qaAgent.kind || 'claude',
          reviewAttempt: nextAttempt,
          prNumber,
          runId,
        });
        await db.collection('agent_runs').doc(runId).set({
          id: runId,
          issueId,
          workspaceId,
          agentId: qaAgentId,
          role: 'qa',
          mode: 'review',
          repo: repoFullName,
          reviewAttempt: nextAttempt,
          startedAt: new Date().toISOString(),
          date: todayKey(),
        });
        console.log(`[QaDispatch] dispatched 'pulse_review' (attempt ${nextAttempt}) for issue '${after.identifier}' to QA '${qaAgentId}' via GitHub Actions.`);
      }
    } catch (error) {
      console.error('[QaDispatch] error handling issue write, will not retry:', error);
    }
  }
);
