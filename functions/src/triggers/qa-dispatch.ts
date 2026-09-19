import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';
import { dispatchRepositoryEvent, getPullRequestHeadSha } from '../github/client';
import { resolveIssueRepo } from '../common/utils/repo-resolution';
import { DAILY_DISPATCH_LIMIT, tryConsumeDailyDispatch } from '../common/utils/dispatch-counter';

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

// Mismo hueco que TES-130 pero del lado de QA: el workflow de revisión tarda
// en arrancar y reclamar (`review.claimedBy`, D5), así que un guard que solo
// mire el estado actual del issue no alcanza para separar dos disparos que
// ocurren antes de que cualquiera llegue a reclamar.
const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

interface ReviewablePr {
  repoFullName: string;
  prNumber: number;
}

/**
 * Los PRs del issue, si TODOS están en condiciones de revisarse: cada rama
 * tiene un PR abierto (ni sin abrir, ni draft, ni cerrado) y no queda ningún
 * traspaso a otro repo sin cerrar (K9/TES-202) — lo mismo que exige
 * `statusFromGitRefs` para dejar entrar el issue a `in_review`, revalidado acá
 * por si algo más lo empujó a este estado.
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
  if (!refs.every((r) => r?.prNumber !== undefined && r.prState === 'open')) return null;

  return refs.map((r) => ({ repoFullName: r.repoFullName, prNumber: r.prNumber }));
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
    secrets: [githubAppId, githubAppPrivateKeyB64],
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

      // Repo contra el que matchear `reviewRepo`: el del issue, o el de su
      // épica si el issue no tiene uno propio (cascada compartida con el
      // dispatch de dev).
      const { repoFullName } = await resolveIssueRepo(db, { ...after, id: issueId }, { agentId: after.assigneeId });
      if (!repoFullName) {
        console.log(`[QaDispatch] issue '${issueId}' no tiene repo resolvable, skipping.`);
        return;
      }

      const qaSnap = await db
        .collection('agents')
        .where('workspaceId', '==', workspaceId)
        .where('role', '==', 'qa')
        .where('enabled', '==', true)
        .where('autonomousMode', '==', true)
        .get();
      // Nunca el mismo agente que es el dev asignado, y el `reviewRepo` tiene
      // que matchear el repo del issue (o el de su épica): con varios
      // agentes QA, es lo único que dice cuál corre el workflow acá.
      const qaDoc = qaSnap.docs.find((d) => d.id !== after.assigneeId && d.data().reviewRepo === repoFullName);
      if (!qaDoc) {
        console.log(`[QaDispatch] no hay agente QA enabled/autonomous con reviewRepo '${repoFullName}' (o el único es el dev asignado), skipping.`);
        return;
      }
      const qaAgent = qaDoc.data();
      const qaAgentId = qaDoc.id;

      const issueRef = db.collection('issues').doc(issueId);
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

      // Anti-ping-pong: si ya hubo un intento cerrado y ningún PR tiene un
      // HEAD distinto del que vio esa revisión, el dev no pusheó nada nuevo y
      // no hay nada que re-revisar. Se lee el SHA en vivo de GitHub (no de
      // `gitRefs`, que todavía no lo trackea — D10/TES-206) contra
      // `review.prs[].headSha` del último veredicto.
      const lastReviewedPrs: Array<{ repoFullName: string; prNumber: number; headSha: string }> = review?.prs || [];
      if (attempt >= 1 && lastReviewedPrs.length > 0) {
        const currentShas = await Promise.all(
          prs.map((pr) => getPullRequestHeadSha(installation.installationId, pr.repoFullName, pr.prNumber))
        );
        const anyChanged = prs.some((pr, i) => {
          const last = lastReviewedPrs.find((p) => p.repoFullName === pr.repoFullName && p.prNumber === pr.prNumber);
          return !last || last.headSha !== currentShas[i];
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

        if (!(await tryConsumeDailyDispatch(tx, db, workspaceId))) {
          return { allowed: false, reason: 'circuit-breaker' } as const;
        }

        tx.update(issueRef, {
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
          console.log(`[QaDispatch] circuit breaker tripped for workspace '${workspaceId}' (limit ${DAILY_DISPATCH_LIMIT}/day), skipping dispatch.`);
        }
        return;
      }

      const authorized: string[] = installation.repositoryFullNames || [];
      if (authorized.length > 0 && !authorized.includes(repoFullName)) {
        console.log(`[QaDispatch] '${repoFullName}' is not in this workspace's GitHub installation, skipping dispatch.`);
        return;
      }

      const nextAttempt = attempt + 1;
      // El job `verify` de pulse-qa.yml (D6) necesita saber qué PR pushear con
      // `gh pr checkout` — el de este mismo repo, no necesariamente el único
      // si el issue es multi-repo (K9/TES-202).
      const prNumber = prs.find((pr) => pr.repoFullName === repoFullName)?.prNumber;
      await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_review', {
        issueId,
        issueIdentifier: after.identifier,
        workspaceId,
        agentId: qaAgentId,
        agentKind: qaAgent.kind || 'claude',
        reviewAttempt: nextAttempt,
        prNumber,
      });

      // D15/TES-211: registro de runs y costo. El paso de reporte del
      // workflow (todavía sin hacer) es el que completa `endedAt`/`costUsd`;
      // acá solo se deja constancia de que el dispatch pasó.
      const runId = `run-${nanoid(8)}`;
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
      });

      console.log(`[QaDispatch] dispatched 'pulse_review' (attempt ${nextAttempt}) for issue '${after.identifier}' (${issueId}) to '${repoFullName}' via QA agent '${qaAgentId}'.`);
    } catch (error) {
      console.error('[QaDispatch] error handling issue write, will not retry:', error);
    }
  }
);
