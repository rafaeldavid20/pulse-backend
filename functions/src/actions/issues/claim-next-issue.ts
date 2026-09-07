import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

// Priority 0 means "None" — it should sort *last*, not first, when ranking
// candidates by urgency (1 Urgent .. 4 Low, then 0).
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

/**
 * The transactional core of `pulse_next_task`: atomically finds and claims
 * the next workable issue for an agent, so two concurrent MCP calls can
 * never claim the same issue. `authorize()` trusts `data.workspaceId`
 * because MCP tools inject it from the already-authenticated `McpPrincipal`,
 * never from the model's tool-call arguments.
 */
export class ClaimNextIssueAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('issues.claimNext', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;
    const actorUid = this.caller.uid!;
    const dryRun = !!data.dryRun;

    if (!data.workspaceId) {
      throw new Error('Parámetro requerido faltante: workspaceId.');
    }

    return db.runTransaction(async (tx: Transaction) => {
      const candidatesQuery = db
        .collection('issues')
        .where('workspaceId', '==', data.workspaceId)
        .where('status', 'in', ['todo', 'backlog']);
      const snap = await tx.get(candidatesQuery);

      const candidates = snap.docs
        .map((d) => ({ ref: d.ref, issue: d.data() }))
        .filter(({ issue }) => {
          if (issue.agent?.state === 'claimed') return false;
          const assignedToMe = issue.assigneeId === actorUid;
          const unassignedAndReady =
            !issue.assigneeId && Array.isArray(issue.labelIds) && issue.labelIds.includes('ai-ready');
          return assignedToMe || unassignedAndReady;
        })
        .sort((a, b) => {
          const pr = priorityRank(a.issue.priority) - priorityRank(b.issue.priority);
          if (pr !== 0) return pr;
          return new Date(a.issue.createdAt).getTime() - new Date(b.issue.createdAt).getTime();
        });

      if (candidates.length === 0) {
        return { found: false };
      }

      const { ref, issue } = candidates[0];

      // Reads for the enriched response — must happen before any write in
      // this transaction (Firestore requires all reads to precede writes).
      const [commentsSnap, projectSnap, labelsSnap, agentSnap] = await Promise.all([
        tx.get(db.collection('comments').where('issueId', '==', ref.id)),
        issue.projectId ? tx.get(db.collection('projects').doc(issue.projectId)) : Promise.resolve(null),
        tx.get(db.collection('labels').where('teamId', '==', issue.teamId)),
        tx.get(db.collection('agents').doc(actorUid)),
      ]);

      if (!dryRun) {
        const now = new Date().toISOString();
        tx.update(ref, {
          assigneeId: actorUid,
          status: 'in_progress',
          'agent.state': 'claimed',
          'agent.claimedBy': actorUid,
          'agent.claimedAt': now,
          updatedAt: now,
        });
      }

      const allLabels = labelsSnap.docs.map((d) => d.data());
      const resolvedLabels = allLabels.filter((l) => (issue.labelIds || []).includes(l.id));
      const branch = `pul/${String(issue.identifier).toLowerCase()}-${slugify(issue.title)}`;
      const agentDoc = agentSnap.exists ? agentSnap.data() : null;

      return {
        found: true,
        dryRun,
        issue: { ...issue, id: ref.id },
        comments: commentsSnap.docs.map((d) => d.data()),
        labels: resolvedLabels,
        project: projectSnap?.exists ? projectSnap.data() : null,
        suggestedBranch: branch,
        defaultRepo: agentDoc?.defaultRepo ?? null,
        nextSteps: [
          `Crear la rama '${branch}' desde la rama base del repo.`,
          'Implementar los cambios descritos en la descripción del issue.',
          'Commitear y pushear la rama.',
          `Abrir un PR y linkearlo al issue ${issue.identifier} (pulse_link_pr, cuando exista).`,
          `Comentar el progreso con pulse_comment_issue sobre '${ref.id}'.`,
          'Cuando el PR esté listo para revisión, pasar el issue a in_review con pulse_update_issue_status.',
        ],
      };
    });
  }
}
