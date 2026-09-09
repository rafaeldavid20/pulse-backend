import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { githubAppId, githubAppPrivateKeyB64 } from '../common/secrets';
import { dispatchRepositoryEvent } from '../github/client';
import { resolveIssueRepo } from '../common/utils/repo-resolution';

const DAILY_DISPATCH_LIMIT = 5;

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Fase 6's autonomous trigger: an issue moving *into* `todo` while assigned
 * to an agent with `autonomousMode` fires a `repository_dispatch` event so
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

      if (after.status !== 'todo' || before?.status === 'todo') return;

      const agentId = after.assigneeId;
      if (!agentId) return;

      const db = getFirestore();
      const agentSnap = await db.collection('agents').doc(agentId).get();
      if (!agentSnap.exists) return;
      const agent = agentSnap.data()!;
      if (!agent.enabled || !agent.autonomousMode) return;

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
      const counterRef = db.collection('agent_dispatch_counters').doc(`${workspaceId}_${today()}`);
      const allowed = await db.runTransaction(async (tx: Transaction) => {
        const snap = await tx.get(counterRef);
        const count = snap.exists ? snap.data()!.count || 0 : 0;
        if (count >= DAILY_DISPATCH_LIMIT) return false;
        tx.set(counterRef, { workspaceId, date: today(), count: FieldValue.increment(1) }, { merge: true });
        return true;
      });
      if (!allowed) {
        console.log(
          `[AgentDispatch] circuit breaker tripped for workspace '${workspaceId}' (limit ${DAILY_DISPATCH_LIMIT}/day), skipping dispatch.`
        );
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
