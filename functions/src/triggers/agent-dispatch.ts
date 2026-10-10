import { reworkRepositories } from '../common/utils/human-rework';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { githubAppId, githubAppPrivateKeyB64, mcpKeyPepper, runnerJobSigningPrivateKey } from '../common/secrets';
import { resolveIssueRepo } from '../common/utils/repo-resolution';
import { checkIssueRunBudget } from '../common/utils/issue-run-budget';
import { buildNeedsHumanEscalation } from '../common/utils/review-escalation';
import { agentVisibility } from '../common/utils/agent-authorization';
import { enqueueRunnerJob, DispatchReservation } from '../common/utils/runner-jobs';
import { reportDispatchFailure, RunnerDispatchError } from '../common/utils/dispatch-failure';
import { runnerProjectRepoAccess } from '../common/utils/project-repos';

async function dispatchRunnerContinuation(
  db: FirebaseFirestore.Firestore, issueId: string, issue: FirebaseFirestore.DocumentData,
  agentId: string, agent: FirebaseFirestore.DocumentData, authorized: string[], repo: string,
  reservation: Exclude<DispatchReservation, boolean>,
) {
  const startedAt = new Date().toISOString();
  try {
    const access = await runnerProjectRepoAccess(db, { ...issue, workspaceId: issue.workspaceId }, authorized);
    if (!access || !access.repos.includes(repo)) throw new RunnerDispatchError('preflight', ['Configurá repositorios en el proyecto y habilitalos en la instalación GitHub; el repositorio destino debe pertenecer a ambos.']);
    await enqueueRunnerJob(db, {
      workspaceId: issue.workspaceId, projectId: access.projectId, issueId, agentId,
      runnerId: agent.runnerId, repoFullName: repo, contextRepos: reservation.mode === 'rework' ? reworkRepositories(issue, access.repos, repo) : access.repos, mode: reservation.mode,
    }, runnerJobSigningPrivateKey.value(), 'runner-job-v1', reservation);
  } catch (error) {
    await reportDispatchFailure(db, issueId, agentId, startedAt, error, reservation.mode === 'handoff' ? { ...reservation, repoFullName: repo } : reservation);
  }
}

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

/**
 * Despacha el run de re-trabajo del dev tras un rechazo de QA (D9): sin este
 * camino, `changes_requested` deja el issue en `in_progress` para siempre —
 * `agentDispatchTrigger` de más abajo solo dispara al *entrar* a `todo`, y
 * `reviews.submit` no toca `agent.dispatchedAt` (ese campo es de la cola de
 * `todo`, no de esta).
 *
 * Reglas propias respecto al dispatch normal: sin cooldown de tiempo — la
 * guarda es `review.attempt` (marcado en `review.reworkDispatchedForAttempt`
 * dentro de la misma transacción que hace el dispatch), porque acá no hay la
 * carrera de TES-130 (un rechazo produce un único write a `changes_requested`,
 * no dos writes separados como assign+status). Y no cuenta al propio issue
 * contra `maxConcurrentIssues`: el dev ya lo tiene `in_progress`, no es un
 * issue nuevo. Sí cuenta contra el tope diario y el de runs por issue
 * (D8/TES-153): un ping-pong de rechazos es exactamente el bucle que esos
 * topes existen para cortar.
 */
async function dispatchRework(
  issueId: string,
  after: FirebaseFirestore.DocumentData,
  agentId: string
): Promise<void> {
  const db = getFirestore();
  const agentSnap = await db.collection('agents').doc(agentId).get();
  const agent = agentSnap.exists ? agentSnap.data()! : null;
  if (!agent || agent.archivedAt || !agent.enabled || !agent.autonomousMode) {
    console.log(`[AgentDispatch] rework for '${issueId}': agent '${agentId}' missing or not enabled/autonomous, skipping.`);
    return;
  }

  const review = after.review as Record<string, any> | undefined;
  const attempt = review?.attempt ?? 0;
  if (review?.reworkDispatchedForAttempt === attempt || after.agent?.state === 'claimed' || ['done', 'canceled'].includes(after.status)) return;
  const startedAt = new Date().toISOString();
  const failPreflight = async (reason: string) => {
    await reportDispatchFailure(db, issueId, agentId, startedAt, new RunnerDispatchError('preflight', [reason]), { mode: 'rework', attempt });
  };

  if (!agent.runnerId) {
    await failPreflight('Los agentes de GitHub Actions fueron retirados. Vinculá un Pulse Runner local antes de reintentar.');
    return;
  }

  // Defensa en profundidad: `reviews.submit` (D5) ya no deja pasar a
  // `changes_requested` con los intentos agotados (ahí el outcome es
  // `needs_human`), pero si esa regla cambia, acá tampoco hay que despachar un
  // re-trabajo que QA no va a poder volver a revisar.
  let maxReviewAttempts = DEFAULT_MAX_REVIEW_ATTEMPTS;
  if (review?.reviewerId) {
    const qaSnap = await db.collection('agents').doc(review.reviewerId).get();
    if (qaSnap.exists) {
      const qaAgent = qaSnap.data()!;
      maxReviewAttempts = qaAgent.maxReviewAttempts ?? DEFAULT_MAX_REVIEW_ATTEMPTS;
      // Modo sombra (D17): `reviews.submit` igual escribe `review.state:
      // 'changes_requested'` para que se vea el veredicto completo, pero
      // mientras el QA no esté en `enforce` ese veredicto no dispara
      // re-trabajo — el issue sigue el flujo humano de hoy.
      if (qaAgent.qaMode !== 'enforce') {
        console.log(`[AgentDispatch] rework for '${issueId}' not dispatched: QA agent '${review.reviewerId}' is in 'shadow' mode (D17).`);
        return;
      }
    }
  }
  if (attempt >= maxReviewAttempts) {
    console.log(`[AgentDispatch] rework for '${issueId}' ya agotó los intentos de revisión (${attempt}/${maxReviewAttempts}), needs_human, no se despacha.`);
    if (review?.state !== 'needs_human') {
      await db.collection('issues').doc(issueId).update({ 'review.state': 'needs_human', updatedAt: new Date().toISOString() });
    }
    return;
  }

  const workspaceId = after.workspaceId;

  // Tope de runs por issue (D8/TES-153), chequeado ANTES de tocar GitHub, como
  // en el dispatch normal y el de traspaso: un ping-pong de rechazos es justo
  // el bucle que este tope cubre.
  const runBudget = await checkIssueRunBudget(db, workspaceId, issueId);
  if (!runBudget.withinBudget) {
    if (runBudget.reason === 'issue-run-limit') {
      console.log(
        `[AgentDispatch] rework for '${issueId}' alcanzó el tope de runs por issue (${runBudget.limit}), needs_human, no se despacha.`
      );
      const escalation = await buildNeedsHumanEscalation(db, after);
      await db
        .collection('issues')
        .doc(issueId)
        .update({ ...escalation, 'review.state': 'needs_human' });
    } else {
      console.log(
        `[AgentDispatch] rework for '${issueId}' alcanzó el techo de costo por issue (USD ${runBudget.capUsd}), skipping.`
      );
    }
    return;
  }

  const installSnap = await db.collection('github_installations').where('workspaceId', '==', workspaceId).limit(1).get();
  if (installSnap.empty) {
    await failPreflight('Conectá una instalación GitHub al workspace antes de reintentar.');
    return;
  }
  const installation = installSnap.docs[0].data();

  // Multi-repo (K9/TES-202): si un finding abierto bloqueante señala un repo
  // puntual distinto del que resolvería la cascada normal, el re-trabajo tiene
  // que ir a ESE repo — ahí está la rama y el PR con el finding, no en el
  // repo por default. "Exactamente un run" (criterio de aceptación): se
  // despacha a un solo repo; si además hace falta tocar otro, el propio
  // prompt le pide al dev usar `pulse_request_repo_work`, igual que en
  // cualquier otro run multi-repo.
  const findings: Array<{ repoFullName?: string; status?: string; severity?: string }> = review?.findings || [];
  const flaggedRepos = Array.from(
    new Set(
      findings
        .filter((f) => f.status === 'open' && (f.severity === 'blocker' || f.severity === 'major') && f.repoFullName)
        .map((f) => f.repoFullName as string)
    )
  );
  const { repoFullName: cascadeRepo } = await resolveIssueRepo(db, { ...after, id: issueId }, { agentId });
  const repoFullName = flaggedRepos.length > 0 && !flaggedRepos.includes(cascadeRepo || '') ? flaggedRepos[0] : cascadeRepo;

  if (!repoFullName) {
    await failPreflight('Configurá el repositorio de la issue, del agente o de su proyecto antes de reintentar.');
    return;
  }

  const authorized: string[] = installation.repositoryFullNames || [];
  if (!authorized.includes(repoFullName)) {
    await failPreflight('Habilitá el repositorio destino en la instalación GitHub del workspace antes de reintentar.');
    return;
  }

  // Un agente vinculado a un Runner debe conservar el mismo transporte en
  // rework: nunca caer a GitHub Actions después de haber ejecutado el primer
  // intento local. Revalidamos Runner y repo antes de emitir el envelope,
  // igual que en el dispatch inicial.
  await dispatchRunnerContinuation(db, issueId, after, agentId, agent, authorized, repoFullName, { mode: 'rework', attempt });
}

/**
 * Despacha el run del repo destino de un traspaso (`issue.pendingRepoWork`).
 *
 * Reglas propias respecto al dispatch normal: no aplica el cooldown (la marca
 * `dispatchedAt` de la entrada ya impide despachar el mismo traspaso dos veces) y
 * no cuenta al propio issue contra `maxConcurrentIssues`, que sigue `in_progress`
 * mientras espera este run. Sí cuenta contra el tope diario: el circuit breaker
 * tiene que cubrir también los bucles que pasen por traspasos.
 */
async function dispatchHandoff(
  issueId: string,
  after: FirebaseFirestore.DocumentData,
  agentId: string,
  targetRepo: string
): Promise<void> {
  const db = getFirestore();
  const agentSnap = await db.collection('agents').doc(agentId).get();
  const agent = agentSnap.exists ? agentSnap.data()! : null;
  if (!agent || agent.archivedAt || !agent.enabled || !agent.autonomousMode) {
    console.log(`[AgentDispatch] handoff for '${issueId}': agent '${agentId}' missing or not enabled/autonomous, skipping.`);
    return;
  }

  const maxConcurrent = agent.maxConcurrentIssues ?? 1;
  const inProgressSnap = await db
    .collection('issues')
    .where('assigneeId', '==', agentId)
    .where('status', '==', 'in_progress')
    .get();
  const others = inProgressSnap.docs.filter((d) => d.id !== issueId).length;
  if (others >= maxConcurrent) {
    console.log(`[AgentDispatch] handoff for '${issueId}': max concurrent reached for agent '${agentId}' (${others}/${maxConcurrent}), skipping.`);
    return;
  }

  const workspaceId = after.workspaceId;
  const entry = (after.pendingRepoWork || []).find((e: any) => e.repoFullName === targetRepo);
  const reservation = { mode: 'handoff' as const, requestedAt: entry?.requestedAt };
  const startedAt = new Date().toISOString();
  const failPreflight = async (reason: string) => {
    await reportDispatchFailure(db, issueId, agentId, startedAt, new RunnerDispatchError('preflight', [reason]), { ...reservation, repoFullName: targetRepo });
  };


  if (!agent.runnerId) {
    await failPreflight('Los agentes de GitHub Actions fueron retirados. Vinculá un Pulse Runner local antes de reintentar.');
    return;
  }

  // Tope de runs por issue (D8/TES-153), chequeado ANTES de tocar GitHub: un
  // traspaso que se re-pide una y otra vez es justo el bucle que este tope
  // cubre y que `maxReviewAttempts` no ve (nunca pasa por QA).
  const runBudget = await checkIssueRunBudget(db, workspaceId, issueId);
  if (!runBudget.withinBudget) {
    if (runBudget.reason === 'issue-run-limit') {
      console.log(
        `[AgentDispatch] handoff for '${issueId}' alcanzó el tope de runs por issue (${runBudget.limit}), needs_human, no se despacha.`
      );
      const escalation = await buildNeedsHumanEscalation(db, after);
      const now = new Date().toISOString();
      await db
        .collection('issues')
        .doc(issueId)
        .update({
          ...escalation,
          // Estampar `dispatchedAt` en la entrada, aunque no se haya
          // despachado de verdad: si no, cualquier otro write al issue (el
          // de esta misma escalación incluido) vuelve a encontrar la
          // entrada sin `dispatchedAt` y reintenta el traspaso en loop.
          pendingRepoWork: (after.pendingRepoWork || []).map((e: any) =>
            e.repoFullName === targetRepo ? { ...e, dispatchedAt: now } : e
          ),
        });
    } else {
      console.log(
        `[AgentDispatch] handoff for '${issueId}' alcanzó el techo de costo por issue (USD ${runBudget.capUsd}), skipping.`
      );
    }
    return;
  }

  const installSnap = await db.collection('github_installations').where('workspaceId', '==', workspaceId).limit(1).get();
  if (installSnap.empty) {
    await failPreflight('Conectá una instalación GitHub al workspace antes de reintentar.');
    return;
  }
  const installation = installSnap.docs[0].data();
  const authorized: string[] = installation.repositoryFullNames || [];
  if (!authorized.includes(targetRepo)) {
    await failPreflight('Habilitá el repositorio destino en la instalación GitHub del workspace antes de reintentar.');
    return;
  }

  await dispatchRunnerContinuation(db, issueId, after, agentId, agent, authorized, targetRepo, reservation);
}

/**
 * Fase 6's autonomous trigger: an issue becoming dispatchable — in `todo` and
 * assigned to an agent with `autonomousMode`, in either order — fires a
 * signed local Runner job. Agents without a Runner remain blocked with
 * an actionable configuration diagnostic.
 *
 * Kill switches gate the dispatch, all checked before ever touching GitHub:
 * `agents/{agentId}.maxConcurrentIssues` (per-agent, how many issues it can
 * have `in_progress` at once), a per-issue run budget
 * (`Workspace.maxRunsPerIssue`/`issueCostCapUsd`, D8/TES-153 — escalates to
 * `needs_human` instead of just skipping, since a loop stuck on one issue
 * never trips the workspace-wide breaker below) and a daily circuit breaker
 * per workspace (`agent_dispatch_counters`, capped at
 * `Workspace.dailyDispatchLimit` or `DAILY_DISPATCH_LIMIT` if unset, plus
 * `Workspace.agentsPaused`/`dailyCostCapUsd`, all in
 * `checkWorkspaceDispatchBudget`) — without these, an
 * issue-created → agent → PR → webhook → issue loop could burn credits
 * indefinitely with only one agent involved.
 *
 * Never throws past the top-level try/catch: an uncaught error in a
 * Firestore trigger makes Cloud Functions retry it, which for this trigger
 * would mean retrying a dispatch — logging and returning is the safe
 * failure mode.
 */
export const agentDispatchTrigger = onDocumentWritten(
  {
    document: 'issues/{issueId}',
    region: 'us-east4',
    secrets: [githubAppId, githubAppPrivateKeyB64, mcpKeyPepper, runnerJobSigningPrivateKey],
  },
  async (event) => {
    try {
      const before = event.data?.before.data();
      const after = event.data?.after.data();
      if (after) after.id = event.params.issueId;
      if (!after) return; // deleted

      // Dispara cuando el issue *se vuelve* despachable: está en `todo` con un
      // asignado, y en el estado anterior no lo estaba. Hay dos formas de
      // llegar ahí y las dos son naturales:
      //
      //   - asignar primero y mover a `todo` después (la única que antes andaba)
      //   - mover a `todo` y asignar después
      //
      // Antes solo se miraba la *entrada* a `todo`, así que el segundo orden
      // fallaba en silencio: al mover no había asignado (return), y al asignar
      // el issue ya estaba en `todo` (return). Pasó con TES-130: quedó en
      // `todo` asignado a Claude y el agente nunca arrancó.
      //
      // Reasignar a otro agente estando en `todo` también dispara, para el nuevo.
      // Cualquier otro update de un issue ya en `todo` con el mismo asignado no
      // dispara, así que no hay doble dispatch por editar un título.
      // Desde TES-284 el responsable humano y el ejecutor son dos campos
      // distintos. El fallback conserva los issues legacy asignados a un
      // agente hasta que se migren desde la UI.
      const agentId = after.execution?.agentId || after.assigneeId;

      // Traspaso a otro repo (TES-202): el run anterior registró trabajo
      // pendiente en otro repo y ya soltó el issue (`agent.state` deja de ser
      // 'claimed'). Se despacha aunque el issue no esté en `todo`, porque sigue
      // en curso; va por su propio camino para no tocar las reglas del de arriba.
      const pendingHandoff = (after.pendingRepoWork || []).find((e: any) => !e.dispatchedAt);
      if (
        pendingHandoff &&
        agentId &&
        after.agent?.state !== 'claimed' &&
        after.status !== 'done' &&
        after.status !== 'canceled'
      ) {
        await dispatchHandoff(event.params.issueId, after, agentId, pendingHandoff.repoFullName);
        return;
      }

      // Reintentar desde Por hacer conserva la continuación vigente: el
      // rechazo sigue en changes_requested aunque el primer enqueue falle.
      // Nunca convertir ese reintento en task ni aplicar su cooldown anterior.
      const enteredChangesRequested =
        after.review?.state === 'changes_requested' && before?.review?.state !== 'changes_requested';
      const enteredTodo = after.status === 'todo' && before?.status !== 'todo';
      const assigneeChanged = (before?.execution?.agentId || before?.assigneeId) !== agentId;
      if (after.review?.state === 'changes_requested' && agentId) {
        if (enteredChangesRequested || enteredTodo || (after.status === 'todo' && assigneeChanged)) {
          await dispatchRework(event.params.issueId, after, agentId);
        }
        return;
      }

      if (after.status !== 'todo' || !agentId) {
        console.log(
          `[AgentDispatch] issue '${event.params.issueId}' not dispatchable (status '${after.status}', assignee '${agentId ?? 'none'}'), skipping dispatch.`
        );
        return;
      }

      if (!enteredTodo && !assigneeChanged) {
        console.log(
          `[AgentDispatch] issue '${event.params.issueId}' already in 'todo' for the same assignee, not a new dispatchable transition, skipping dispatch.`
        );
        return;
      }

      const db = getFirestore();
      const agentSnap = await db.collection('agents').doc(agentId).get();
      if (!agentSnap.exists) {
        console.log(`[AgentDispatch] agent '${agentId}' does not exist, skipping dispatch.`);
        return;
      }
      const agent = agentSnap.data()!;
      if (agent.archivedAt) {
        console.log(`[AgentDispatch] agent '${agentId}' is archived, skipping dispatch.`);
        return;
      }
      if (!agent.enabled || !agent.autonomousMode) {
        console.log(
          `[AgentDispatch] agent '${agentId}' is not enabled/autonomous (enabled=${!!agent.enabled}, autonomousMode=${!!agent.autonomousMode}), skipping dispatch.`
        );
        return;
      }

      if (!agent.runnerId) {
        await reportDispatchFailure(db, event.params.issueId, agentId, new Date().toISOString(), new RunnerDispatchError('preflight', ['Los agentes de GitHub Actions fueron retirados. Vinculá un Pulse Runner local antes de reintentar.']));
        return;
      }

      const visibility = agentVisibility(agent);
      const responsibleMemberId = after.responsibleMemberId || (after.execution ? after.assigneeId : undefined);
      if (visibility === 'personal' && agent.ownerMemberId !== responsibleMemberId) {
        console.log(
          `[AgentDispatch] personal agent '${agentId}' cannot execute issue '${event.params.issueId}' owned by '${responsibleMemberId ?? 'none'}', skipping dispatch.`
        );
        return;
      }

      const maxConcurrent = agent.maxConcurrentIssues ?? 1;
      const [legacyInProgressSnap, executionInProgressSnap] = await Promise.all([
        db.collection('issues').where('assigneeId', '==', agentId).where('status', '==', 'in_progress').get(),
        db.collection('issues').where('execution.agentId', '==', agentId).where('status', '==', 'in_progress').get(),
      ]);
      const inProgressCount = new Set([
        ...legacyInProgressSnap.docs.map((doc) => doc.id),
        ...executionInProgressSnap.docs.map((doc) => doc.id),
      ]).size;
      if (inProgressCount >= maxConcurrent) {
        console.log(
          `[AgentDispatch] max concurrent reached for agent '${agentId}' (${inProgressCount}/${maxConcurrent}), skipping dispatch.`
        );
        return;
      }

      const workspaceId = after.workspaceId;

      // Tope de runs por issue (D8/TES-153), chequeado antes de la
      // transacción de dispatch: si se agota, hay que escalar el issue a un
      // humano, no solo saltear este dispatch.
      const runBudget = await checkIssueRunBudget(db, workspaceId, event.params.issueId);
      if (!runBudget.withinBudget) {
        if (runBudget.reason === 'issue-run-limit') {
          console.log(
            `[AgentDispatch] issue '${event.params.issueId}' alcanzó el tope de runs por issue (${runBudget.limit}), needs_human, skipping dispatch.`
          );
          const escalation = await buildNeedsHumanEscalation(db, after);
          await db.collection('issues').doc(event.params.issueId).update(escalation);
        } else {
          console.log(
            `[AgentDispatch] issue '${event.params.issueId}' alcanzó el techo de costo por issue (USD ${runBudget.capUsd}), skipping dispatch.`
          );
        }
        return;
      }

      // Preflight antes de reservar el presupuesto/cooldown: un Runner
      // offline o un repo no autorizado no debe consumir un dispatch que no
      // llegó a ejecutarse.
      const dispatchStartedAt = new Date().toISOString();
      const failPreflight = async (reason: string) => reportDispatchFailure(db, event.params.issueId, agentId, dispatchStartedAt, new RunnerDispatchError('preflight', [reason]));
      const preflightInstallSnap = await db
        .collection('github_installations')
        .where('workspaceId', '==', workspaceId)
        .limit(1)
        .get();
      if (preflightInstallSnap.empty) {
        await failPreflight('Conectá una instalación GitHub al workspace antes de reintentar.');
        return;
      }
      const preflightInstallation = preflightInstallSnap.docs[0].data();
      const preflightRepo = await resolveIssueRepo(db, { ...after, id: event.params.issueId }, {
        agentId,
        installationRepos: preflightInstallation.repositoryFullNames || [],
      });
      if (!preflightRepo.repoFullName) {
        await failPreflight('Configurá el repositorio de la issue, del agente o de su proyecto antes de reintentar.');
        return;
      }
      const preflightAuthorized: string[] = preflightInstallation.repositoryFullNames || [];
      if (!preflightAuthorized.includes(preflightRepo.repoFullName)) {
        await failPreflight('Habilitá el repositorio destino en la instalación GitHub del workspace antes de reintentar.');
        return;
      }
      if (agent.runnerId) {
        const startedAt = new Date().toISOString();
        try {
          const access = await runnerProjectRepoAccess(db, { ...after, workspaceId }, preflightAuthorized);
          if (!access || !access.repos.includes(preflightRepo.repoFullName)) throw new RunnerDispatchError('preflight', ['Configurá repositorios en el proyecto y habilitalos en la instalación GitHub; el repositorio destino debe pertenecer a ambos.']);
          const job = await enqueueRunnerJob(db, {
            workspaceId, projectId: access.projectId, issueId: event.params.issueId,
            agentId, runnerId: agent.runnerId, repoFullName: preflightRepo.repoFullName,
            contextRepos: access.repos, mode: 'task',
          }, runnerJobSigningPrivateKey.value(), 'runner-job-v1', true);
          console.log(`[AgentDispatch] enqueued Runner job '${job.id}' for issue '${after.identifier}'.`);
        } catch (error) {
          await reportDispatchFailure(db, event.params.issueId, agentId, startedAt, error);
        }
        return;
      }

    } catch (error) {
      console.error('[AgentDispatch] error handling issue write, will not retry:', error);
    }
  }
);
