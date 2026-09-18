import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';
import { dispatchRepositoryEvent } from '../github/client';
import { resolveIssueRepo } from '../common/utils/repo-resolution';

const DAILY_DISPATCH_LIMIT = 5;

// Un run tarda ~30s en arrancar y reclamar el issue (ver `agent.state ===
// 'claimed'` en claim-issue.ts), así que ese guard solo no alcanza para
// separar dos dispatches que ocurren antes de que cualquiera llegue a
// reclamar (TES-130: dos dispatches en 4s, mismo issue, mismo agente, dos
// runs en paralelo). Esta ventana cubre ese hueco.
const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
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

  const issueRef = db.collection('issues').doc(issueId);
  const counterRef = db.collection('agent_dispatch_counters').doc(`${workspaceId}_${today()}`);
  const decision = await db.runTransaction(async (tx: Transaction) => {
    const issueSnap = await tx.get(issueRef);
    const pending: any[] = issueSnap.data()?.pendingRepoWork || [];
    const entry = pending.find((e) => e.repoFullName === targetRepo);
    // Otro trigger concurrente ya lo despachó, o el traspaso se cerró.
    if (!entry || entry.dispatchedAt) return { allowed: false, reason: 'already-dispatched' } as const;

    const counterSnap = await tx.get(counterRef);
    const count = counterSnap.exists ? counterSnap.data()!.count || 0 : 0;
    if (count >= DAILY_DISPATCH_LIMIT) return { allowed: false, reason: 'circuit-breaker' } as const;

    const now = new Date().toISOString();
    tx.set(counterRef, { workspaceId, date: today(), count: FieldValue.increment(1) }, { merge: true });
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

  await dispatchRepositoryEvent(installation.installationId, targetRepo, 'pulse_task', {
    issueId,
    issueIdentifier: after.identifier,
    workspaceId,
    agentId,
    agentKind: agent.kind || 'claude',
    // El workflow usa esto para decirle al agente que es la continuación de un
    // traspaso y que el detalle está en `pendingRepoWork` del issue.
    handoffRepo: targetRepo,
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
 * Two independent kill switches gate the dispatch, both checked before ever
 * touching GitHub: `agents/{agentId}.maxConcurrentIssues` (per-agent, how
 * many issues it can have `in_progress` at once) and a daily circuit
 * breaker per workspace (`agent_dispatch_counters`, capped at
 * `DAILY_DISPATCH_LIMIT`) — without the second one, a
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
    secrets: [githubAppId, githubAppPrivateKeyB64],
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
      const agentId = after.assigneeId;

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

      if (after.status !== 'todo' || !agentId) {
        console.log(
          `[AgentDispatch] issue '${event.params.issueId}' not dispatchable (status '${after.status}', assignee '${agentId ?? 'none'}'), skipping dispatch.`
        );
        return;
      }

      const enteredTodo = before?.status !== 'todo';
      const assigneeChanged = before?.assigneeId !== agentId;
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

      const maxConcurrent = agent.maxConcurrentIssues ?? 1;
      const inProgressSnap = await db
        .collection('issues')
        .where('assigneeId', '==', agentId)
        .where('status', '==', 'in_progress')
        .get();
      if (inProgressSnap.size >= maxConcurrent) {
        console.log(
          `[AgentDispatch] max concurrent reached for agent '${agentId}' (${inProgressSnap.size}/${maxConcurrent}), skipping dispatch.`
        );
        return;
      }

      const workspaceId = after.workspaceId;
      const issueRef = db.collection('issues').doc(event.params.issueId);
      const counterRef = db.collection('agent_dispatch_counters').doc(`${workspaceId}_${today()}`);
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

        const counterSnap = await tx.get(counterRef);
        const count = counterSnap.exists ? counterSnap.data()!.count || 0 : 0;
        if (count >= DAILY_DISPATCH_LIMIT) {
          return { allowed: false, reason: 'circuit-breaker' } as const;
        }

        tx.set(counterRef, { workspaceId, date: today(), count: FieldValue.increment(1) }, { merge: true });
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
            `[AgentDispatch] circuit breaker tripped for workspace '${workspaceId}' (limit ${DAILY_DISPATCH_LIMIT}/day), skipping dispatch.`
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

      await dispatchRepositoryEvent(installation.installationId, repoFullName, 'pulse_task', {
        issueId: event.params.issueId,
        issueIdentifier: after.identifier,
        workspaceId,
        agentId,
        // Permite que varios runners escuchen el mismo tipo de evento y cada
        // uno filtre por el suyo, en vez de inventar un tipo por proveedor.
        agentKind: agent.kind || 'claude',
      });

      console.log(
        `[AgentDispatch] dispatched 'pulse_task' (${agent.kind || 'claude'}) for issue '${after.identifier}' (${event.params.issueId}) to '${repoFullName}' (repo via ${source}).`
      );
    } catch (error) {
      console.error('[AgentDispatch] error handling issue write, will not retry:', error);
    }
  }
);
