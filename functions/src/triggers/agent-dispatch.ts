import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { nanoid } from 'nanoid';
import { githubAppId, githubAppPrivateKeyB64, mcpKeyPepper, runnerJobSigningPrivateKey } from '../common/secrets';
import { dispatchRepositoryEvent } from '../github/client';
import { resolveIssueRepo } from '../common/utils/repo-resolution';
import { checkWorkspaceDispatchBudget, todayKey } from '../common/utils/dispatch-counter';
import { checkIssueRunBudget } from '../common/utils/issue-run-budget';
import { buildNeedsHumanEscalation } from '../common/utils/review-escalation';
import { agentAllowedRepos, agentVisibility } from '../common/utils/agent-authorization';
import { enqueueRunnerJob } from '../common/utils/runner-jobs';
import { isRunnerAvailable } from '../common/utils/runner-availability';
import { allowedReposForIssue } from '../common/utils/project-repos';

// Un run tarda ~30s en arrancar y reclamar el issue (ver `agent.state ===
// 'claimed'` en claim-issue.ts), así que ese guard solo no alcanza para
// separar dos dispatches que ocurren antes de que cualquiera llegue a
// reclamar (TES-130: dos dispatches en 4s, mismo issue, mismo agente, dos
// runs en paralelo). Esta ventana cubre ese hueco.
const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

const DEFAULT_MAX_REVIEW_ATTEMPTS = 2;

/** Repos que un Runner puede montar juntos para un único job, sin salir del proyecto ni de sus allow-lists. */
async function runnerContextRepos(
  db: FirebaseFirestore.Firestore,
  issue: FirebaseFirestore.DocumentData,
  agent: FirebaseFirestore.DocumentData,
  runner: FirebaseFirestore.DocumentData,
  installationRepos: string[],
): Promise<string[]> {
  const projectRepos = await allowedReposForIssue(db, issue, installationRepos);
  const agentRepos = agentAllowedRepos(agent);
  return projectRepos.filter((repo) =>
    runner.connectedRepos?.includes(repo) && (agentRepos.length === 0 || agentRepos.includes(repo))
  );
}

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
  if (!agent || !agent.enabled || !agent.autonomousMode) {
    console.log(`[AgentDispatch] rework for '${issueId}': agent '${agentId}' missing or not enabled/autonomous, skipping.`);
    return;
  }

  const review = after.review as Record<string, any> | undefined;
  const attempt = review?.attempt ?? 0;

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
    console.log(`[AgentDispatch] rework for '${issueId}': workspace '${workspaceId}' has no GitHub installation, skipping.`);
    return;
  }
  const installation = installSnap.docs[0].data();

  const issueRef = db.collection('issues').doc(issueId);
  const decision = await db.runTransaction(async (tx: Transaction) => {
    const issueSnap = await tx.get(issueRef);
    const currentReview = issueSnap.data()?.review as Record<string, any> | undefined;
    // Otro trigger concurrente ya lo despachó, o el intento ya no está
    // rechazado (por ejemplo, un humano lo movió a mano).
    if (!currentReview || currentReview.state !== 'changes_requested') {
      return { allowed: false, reason: 'not-changes-requested' } as const;
    }
    if (currentReview.reworkDispatchedForAttempt === currentReview.attempt) {
      return { allowed: false, reason: 'already-dispatched' } as const;
    }

    const budget = await checkWorkspaceDispatchBudget(tx, db, workspaceId);
    if (!budget.allowed) return { allowed: false, reason: budget.reason } as const;

    const now = new Date().toISOString();
    tx.update(issueRef, {
      'review.reworkDispatchedAt': now,
      'review.reworkDispatchedForAttempt': currentReview.attempt,
    });
    return { allowed: true } as const;
  });
  if (!decision.allowed) {
    console.log(`[AgentDispatch] rework for '${issueId}' not dispatched (${decision.reason}).`);
    return;
  }

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
    console.log(`[AgentDispatch] rework for '${issueId}': no resolvable repo, skipping.`);
    return;
  }

  const authorized: string[] = installation.repositoryFullNames || [];
  if (authorized.length > 0 && !authorized.includes(repoFullName)) {
    console.log(`[AgentDispatch] rework for '${issueId}': '${repoFullName}' is not in this workspace's GitHub installation, skipping.`);
    return;
  }

  // Un agente vinculado a un Runner debe conservar el mismo transporte en
  // rework: nunca caer a GitHub Actions después de haber ejecutado el primer
  // intento local. Revalidamos Runner y repo antes de emitir el envelope,
  // igual que en el dispatch inicial.
  if (agent.runnerId) {
    const runnerSnap = await db.collection('runners').doc(agent.runnerId).get();
    if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== workspaceId) {
      console.log(`[AgentDispatch] rework for '${issueId}': runner '${agent.runnerId}' does not exist in this workspace, skipping.`);
      return;
    }
    const runner = runnerSnap.data()!;
    if (!isRunnerAvailable(runner)) {
      console.log(`[AgentDispatch] rework for '${issueId}': runner '${agent.runnerId}' is offline, revoked, or has an expired heartbeat, skipping.`);
      return;
    }
    if (!Array.isArray(runner.connectedRepos) || !runner.connectedRepos.includes(repoFullName)) {
      console.log(`[AgentDispatch] rework for '${issueId}': runner '${agent.runnerId}' is not connected to '${repoFullName}', skipping.`);
      return;
    }
    const contextRepos = await runnerContextRepos(db, after, agent, runner, authorized);
    const job = await enqueueRunnerJob(db, {
      workspaceId, issueId, agentId, runnerId: agent.runnerId, repoFullName, contextRepos, mode: 'rework',
    }, runnerJobSigningPrivateKey.value());
    await db.collection('agent_runs').doc(job.id).set({
      id: job.id, issueId, workspaceId, agentId, role: 'dev', mode: 'rework', repo: repoFullName,
      runnerId: agent.runnerId, reviewAttempt: attempt, startedAt: new Date().toISOString(), date: todayKey(),
    });
    console.log(`[AgentDispatch] enqueued Runner rework job '${job.id}' for issue '${after.identifier}' to '${agent.runnerId}'.`);
    return;
  }

  // D15/TES-211: el runId se genera ANTES del dispatch para poder mandarlo en
  // el `client_payload` — el paso de reporte del workflow lo necesita para
  // saber qué registro de `agent_runs` cerrar con `runs.complete`.
  const runId = `run-${nanoid(8)}`;
  await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_task', {
    issueId,
    issueIdentifier: after.identifier,
    workspaceId,
    agentId,
    agentKind: agent.kind || 'claude',
    // El workflow usa esto para correr el job de re-trabajo en vez del de
    // tarea nueva: sin rama ni PR nuevos, checkout de la rama existente y
    // push al mismo PR.
    mode: 'rework',
    reviewAttempt: attempt,
    runId,
  });

  // D15/TES-211: registro de runs y costo, mismo motivo que en el dispatch
  // normal y el de traspaso.
  await db
    .collection('agent_runs')
    .doc(runId)
    .set({
      id: runId,
      issueId,
      workspaceId,
      agentId,
      role: 'dev',
      mode: 'rework',
      repo: repoFullName,
      reviewAttempt: attempt,
      startedAt: new Date().toISOString(),
      date: todayKey(),
    });

  console.log(
    `[AgentDispatch] dispatched rework 'pulse_task' (attempt ${attempt}) for issue '${after.identifier}' (${issueId}) to '${repoFullName}'.`
  );
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
  if (!agent || !agent.enabled || !agent.autonomousMode) {
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
    console.log(`[AgentDispatch] handoff for '${issueId}': workspace '${workspaceId}' has no GitHub installation, skipping.`);
    return;
  }
  const installation = installSnap.docs[0].data();
  const authorized: string[] = installation.repositoryFullNames || [];
  if (authorized.length > 0 && !authorized.includes(targetRepo)) {
    console.log(`[AgentDispatch] handoff for '${issueId}': '${targetRepo}' is not in this workspace's GitHub installation, skipping.`);
    return;
  }

  // Validar el Runner antes de reservar el traspaso. Si se escribiera
  // `pendingRepoWork.dispatchedAt` primero y el Runner estuviera offline o
  // sin el repo, el entry quedaría marcado como enviado sin ningún job que lo
  // pueda completar (exactamente el estado que después no se puede reintentar).
  let runner: FirebaseFirestore.DocumentData | undefined;
  if (agent.runnerId) {
    const runnerSnap = await db.collection('runners').doc(agent.runnerId).get();
    if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== workspaceId) {
      console.log(`[AgentDispatch] handoff for '${issueId}': runner '${agent.runnerId}' does not exist in this workspace, skipping.`);
      return;
    }
    runner = runnerSnap.data()!;
    if (!isRunnerAvailable(runner) || !runner.connectedRepos?.includes(targetRepo)) {
      console.log(`[AgentDispatch] handoff for '${issueId}': runner '${agent.runnerId}' is unavailable or lacks '${targetRepo}', skipping.`);
      return;
    }
  }

  const issueRef = db.collection('issues').doc(issueId);
  const decision = await db.runTransaction(async (tx: Transaction) => {
    const issueSnap = await tx.get(issueRef);
    const pending: any[] = issueSnap.data()?.pendingRepoWork || [];
    const entry = pending.find((e) => e.repoFullName === targetRepo);
    // Otro trigger concurrente ya lo despachó, o el traspaso se cerró.
    if (!entry || entry.dispatchedAt) return { allowed: false, reason: 'already-dispatched' } as const;

    const budget = await checkWorkspaceDispatchBudget(tx, db, workspaceId);
    if (!budget.allowed) return { allowed: false, reason: budget.reason } as const;

    const now = new Date().toISOString();
    tx.update(issueRef, {
      pendingRepoWork: pending.map((e) => (e.repoFullName === targetRepo ? { ...e, dispatchedAt: now } : e)),
      'agent.dispatchedAt': now,
      'agent.dispatchedTo': agentId,
    });
    return { allowed: true } as const;
  });
  if (!decision.allowed) {
    console.log(`[AgentDispatch] handoff for '${issueId}' to '${targetRepo}' not dispatched (${decision.reason}).`);
    return;
  }

  // Un handoff conserva el transporte local del agente. Enviar este camino a
  // GitHub Actions dejaba el Runner sin el repo destino y el workflow podía
  // quedar skipped para adaptadores locales.
  if (agent.runnerId) {
    const contextRepos = await runnerContextRepos(db, after, agent, runner!, authorized);
    const job = await enqueueRunnerJob(db, {
      workspaceId, issueId, agentId, runnerId: agent.runnerId, repoFullName: targetRepo, contextRepos, mode: 'handoff',
    }, runnerJobSigningPrivateKey.value());
    await db.collection('agent_runs').doc(job.id).set({
      id: job.id, issueId, workspaceId, agentId, role: 'dev', mode: 'handoff', repo: targetRepo,
      runnerId: agent.runnerId, startedAt: new Date().toISOString(), date: todayKey(),
    });
    console.log(`[AgentDispatch] enqueued Runner handoff job '${job.id}' for issue '${after.identifier}' to '${agent.runnerId}'.`);
    return;
  }

  // D15/TES-211: ver el comentario equivalente en `dispatchRework`.
  const runId = `run-${nanoid(8)}`;
  await dispatchRepositoryEvent(installation.installationId, targetRepo, 'pulse_task', {
    issueId,
    issueIdentifier: after.identifier,
    workspaceId,
    agentId,
    agentKind: agent.kind || 'claude',
    // El workflow usa esto para decirle al agente que es la continuación de un
    // traspaso y que el detalle está en `pendingRepoWork` del issue.
    handoffRepo: targetRepo,
    runId,
  });

  // D15/TES-211: registro de runs y costo, ahora también del lado dev (antes
  // solo `qa-dispatch.ts` creaba `agent_runs`) — sin esto, el tope de runs
  // por issue no podía contar los traspasos que motivaron la historia.
  await db
    .collection('agent_runs')
    .doc(runId)
    .set({
      id: runId,
      issueId,
      workspaceId,
      agentId,
      role: 'dev',
      mode: 'handoff',
      repo: targetRepo,
      startedAt: new Date().toISOString(),
      date: todayKey(),
    });

  console.log(`[AgentDispatch] dispatched handoff 'pulse_task' for issue '${after.identifier}' (${issueId}) to '${targetRepo}'.`);
}

/**
 * Fase 6's autonomous trigger: an issue becoming dispatchable — in `todo` and
 * assigned to an agent with `autonomousMode`, in either order — fires a
 * `repository_dispatch` event so
 * `.github/workflows/pulse-agent.yml` picks it up — no human has to open
 * Claude Code and say "take the next task."
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

      // Re-trabajo tras un rechazo de QA (D9/TES-205): dispara al *entrar* a
      // `changes_requested`, gemelo del `enteredTodo` de más abajo pero para
      // este otro camino de dispatch — sin esto, el issue queda en
      // `in_progress` para siempre después del primer rechazo, porque el
      // dispatch de `todo` de acá abajo nunca se activa (el status ya no es
      // `todo`).
      const enteredChangesRequested =
        after.review?.state === 'changes_requested' && before?.review?.state !== 'changes_requested';
      if (enteredChangesRequested && agentId) {
        await dispatchRework(event.params.issueId, after, agentId);
        return;
      }

      if (after.status !== 'todo' || !agentId) {
        console.log(
          `[AgentDispatch] issue '${event.params.issueId}' not dispatchable (status '${after.status}', assignee '${agentId ?? 'none'}'), skipping dispatch.`
        );
        return;
      }

      const enteredTodo = before?.status !== 'todo';
      const assigneeChanged = (before?.execution?.agentId || before?.assigneeId) !== agentId;
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
      if (!agent.enabled || !agent.autonomousMode) {
        console.log(
          `[AgentDispatch] agent '${agentId}' is not enabled/autonomous (enabled=${!!agent.enabled}, autonomousMode=${!!agent.autonomousMode}), skipping dispatch.`
        );
        return;
      }
      const allowedRepos = agentAllowedRepos(agent);

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
      const preflightInstallSnap = await db
        .collection('github_installations')
        .where('workspaceId', '==', workspaceId)
        .limit(1)
        .get();
      if (preflightInstallSnap.empty) {
        console.log(`[AgentDispatch] workspace '${workspaceId}' has no GitHub installation, skipping dispatch.`);
        return;
      }
      const preflightInstallation = preflightInstallSnap.docs[0].data();
      const preflightRepo = await resolveIssueRepo(db, { ...after, id: event.params.issueId }, {
        agentId,
        installationRepos: preflightInstallation.repositoryFullNames || [],
      });
      if (!preflightRepo.repoFullName) {
        console.log(`[AgentDispatch] no resolvable repo for agent '${agentId}' / issue '${event.params.issueId}', skipping dispatch.`);
        return;
      }
      const preflightAuthorized: string[] = preflightInstallation.repositoryFullNames || [];
      if (preflightAuthorized.length > 0 && !preflightAuthorized.includes(preflightRepo.repoFullName)) {
        console.log(`[AgentDispatch] '${preflightRepo.repoFullName}' is not in this workspace's GitHub installation, skipping dispatch.`);
        return;
      }
      if (allowedRepos.length > 0 && !allowedRepos.includes(preflightRepo.repoFullName)) {
        console.log(`[AgentDispatch] agent '${agentId}' is not connected to '${preflightRepo.repoFullName}', skipping dispatch.`);
        return;
      }
      if (agent.runnerId) {
        const runnerSnap = await db.collection('runners').doc(agent.runnerId).get();
        const runner = runnerSnap.exists ? runnerSnap.data()! : null;
        if (!runner || runner.workspaceId !== workspaceId || !isRunnerAvailable(runner) || !runner.connectedRepos?.includes(preflightRepo.repoFullName)) {
          console.log(`[AgentDispatch] runner '${agent.runnerId}' is missing, offline, or lacks '${preflightRepo.repoFullName}', skipping dispatch.`);
          return;
        }
      }

      const issueRef = db.collection('issues').doc(event.params.issueId);
      const dispatchDecision = await db.runTransaction(async (tx: Transaction) => {
        // Leer el propio issue dentro de la transacción, no el `after` del
        // evento: dos triggers concurrentes parten del mismo `after` pero
        // solo uno de ellos debe ganar la carrera a escribir la marca.
        const issueSnap = await tx.get(issueRef);
        const dispatchedAt: string | undefined = issueSnap.data()?.agent?.dispatchedAt;
        const dispatchedTo: string | undefined = issueSnap.data()?.agent?.dispatchedTo;
        if (dispatchedTo === agentId && dispatchedAt) {
          const elapsedMs = Date.now() - new Date(dispatchedAt).getTime();
          if (elapsedMs < DISPATCH_COOLDOWN_MS) {
            return { allowed: false, reason: 'recent-dispatch', elapsedMs } as const;
          }
        }

        const budget = await checkWorkspaceDispatchBudget(tx, db, workspaceId);
        if (!budget.allowed) return { allowed: false, reason: budget.reason } as const;

        tx.update(issueRef, {
          'agent.dispatchedAt': new Date().toISOString(),
          'agent.dispatchedTo': agentId,
        });
        return { allowed: true } as const;
      });
      if (!dispatchDecision.allowed) {
        if (dispatchDecision.reason === 'recent-dispatch') {
          console.log(
            `[AgentDispatch] issue '${event.params.issueId}' already dispatched to agent '${agentId}' ${Math.round(
              dispatchDecision.elapsedMs / 1000
            )}s ago (cooldown ${DISPATCH_COOLDOWN_MS / 1000}s) and not released since, skipping dispatch.`
          );
        } else {
          console.log(
            `[AgentDispatch] dispatch blocked for workspace '${workspaceId}' (${dispatchDecision.reason}), skipping dispatch.`
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
        console.log(`[AgentDispatch] workspace '${workspaceId}' has no GitHub installation, skipping dispatch.`);
        return;
      }
      const installation = installSnap.docs[0].data();

      // Cascada issue -> épica -> agente -> instalación. Antes era
      // `agent.defaultRepo || after.git?.repoFullName`, que hacía ganar al
      // default del agente sobre el repo puesto explícitamente en el issue —
      // el override por issue era inalcanzable.
      const { repoFullName, source } = await resolveIssueRepo(db, { ...after, id: event.params.issueId }, {
        agentId,
        installationRepos: installation.repositoryFullNames || [],
      });

      if (!repoFullName) {
        console.log(`[AgentDispatch] no resolvable repo for agent '${agentId}' / issue '${event.params.issueId}', skipping dispatch.`);
        return;
      }

      // Un repo fuera de la instalación no puede recibir el dispatch, y
      // fallar acá con un mensaje claro es mejor que un 404 de GitHub.
      const authorized: string[] = installation.repositoryFullNames || [];
      if (authorized.length > 0 && !authorized.includes(repoFullName)) {
        console.log(
          `[AgentDispatch] '${repoFullName}' (via ${source}) is not in this workspace's GitHub installation, skipping dispatch.`
        );
        return;
      }
      if (allowedRepos.length > 0 && !allowedRepos.includes(repoFullName)) {
        console.log(
          `[AgentDispatch] agent '${agentId}' is not connected to '${repoFullName}', skipping dispatch.`
        );
        return;
      }

      // Un agente con Runner no cae al workflow de GitHub Actions: el trabajo
      // se entrega como envelope firmado al proceso local que el usuario
      // vinculó. La verificación de estado/repo ocurre acá, antes de crear el
      // run, y el Runner vuelve a validar la firma/vencimiento antes de tocar
      // el worktree.
      if (agent.runnerId) {
        const runnerSnap = await db.collection('runners').doc(agent.runnerId).get();
        if (!runnerSnap.exists || runnerSnap.data()!.workspaceId !== workspaceId) {
          console.log(`[AgentDispatch] runner '${agent.runnerId}' for agent '${agentId}' does not exist in this workspace, skipping dispatch.`);
          return;
        }
        const runner = runnerSnap.data()!;
        if (!isRunnerAvailable(runner)) {
          console.log(`[AgentDispatch] runner '${agent.runnerId}' is offline, revoked, or has an expired heartbeat, skipping dispatch.`);
          return;
        }
        if (!Array.isArray(runner.connectedRepos) || !runner.connectedRepos.includes(repoFullName)) {
          console.log(`[AgentDispatch] runner '${agent.runnerId}' is not connected to '${repoFullName}', skipping dispatch.`);
          return;
        }
        const contextRepos = await runnerContextRepos(db, after, agent, runner, authorized);
        const job = await enqueueRunnerJob(db, {
          workspaceId,
          issueId: event.params.issueId,
          agentId,
          runnerId: agent.runnerId,
          repoFullName,
          contextRepos,
          mode: 'task',
        }, runnerJobSigningPrivateKey.value());
        await db.collection('agent_runs').doc(job.id).set({
          id: job.id,
          issueId: event.params.issueId,
          workspaceId,
          agentId,
          role: 'dev',
          mode: 'task',
          repo: repoFullName,
          runnerId: agent.runnerId,
          startedAt: new Date().toISOString(),
          date: todayKey(),
        });
        console.log(`[AgentDispatch] enqueued Runner job '${job.id}' for issue '${after.identifier}' to '${agent.runnerId}'.`);
        return;
      }

      // D15/TES-211: ver el comentario equivalente en `dispatchRework`.
      const runId = `run-${nanoid(8)}`;
      await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_task', {
        issueId: event.params.issueId,
        issueIdentifier: after.identifier,
        workspaceId,
        agentId,
        // Permite que varios runners escuchen el mismo tipo de evento y cada
        // uno filtre por el suyo, en vez de inventar un tipo por proveedor.
        agentKind: agent.kind || 'claude',
        runId,
      });

      // D15/TES-211: registro de runs y costo (mismo motivo que en el
      // traspaso de más arriba — sin esto, el tope de runs por issue no
      // contaba los dispatches normales de dev).
      await db
        .collection('agent_runs')
        .doc(runId)
        .set({
          id: runId,
          issueId: event.params.issueId,
          workspaceId,
          agentId,
          role: 'dev',
          mode: 'task',
          repo: repoFullName,
          startedAt: new Date().toISOString(),
          date: todayKey(),
        });

      console.log(
        `[AgentDispatch] dispatched 'pulse_task' (${agent.kind || 'claude'}) for issue '${after.identifier}' (${event.params.issueId}) to '${repoFullName}' (repo via ${source}).`
      );
    } catch (error) {
      console.error('[AgentDispatch] error handling issue write, will not retry:', error);
    }
  }
);
