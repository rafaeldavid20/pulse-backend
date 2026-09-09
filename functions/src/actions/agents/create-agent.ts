import { getFirestore } from 'firebase-admin/firestore';
import { PlatformActionHandler } from '../../common/platform-actions/handler';
import { PlatformActionRequest } from '../../common/platform-actions/interfaces';
import { cleanUndefined } from '../../common/utils/clean';
import { AgentRole } from '../../common/domain.generated';

const AGENT_ROLES: AgentRole[] = ['dev', 'qa'];

/**
 * Creates an agent as a real workspace `member` — not a special case in the
 * assignee selectors, which already read from `members`. `role` is mirrored
 * onto the member as `agentRole` so those selectors can group Humanos / Dev /
 * QA without reading `agents`, which is Admin-SDK-only. `agents/{agentId}`
 * keeps the operational bits (repo defaults, concurrency limits) that don't
 * belong on a `Member`.
 */
export class CreateAgentAction extends PlatformActionHandler {
  private workspaceId?: string;

  constructor(request: PlatformActionRequest, callerUid?: string, callerEmail?: string) {
    super('agents.create', request, callerUid, callerEmail);
    this.workspaceId = request.data?.workspaceId;
  }

  protected async authorize(): Promise<boolean> {
    if (!this.workspaceId) return false;
    return this.isWorkspaceMember(this.workspaceId);
  }

  protected async handleAction(): Promise<Record<string, any>> {
    const db = getFirestore();
    const data = this.action.data;

    if (!data.workspaceId || !data.agentId || !data.kind || !data.displayName) {
      throw new Error('Parámetros requeridos faltantes: workspaceId, agentId, kind, displayName.');
    }
    if (data.role !== undefined && !AGENT_ROLES.includes(data.role)) {
      throw new Error(`role inválido: '${data.role}'. Debe ser 'dev' o 'qa'.`);
    }
    const role: AgentRole = data.role ?? 'dev';

    const agent = {
      id: data.agentId,
      workspaceId: data.workspaceId,
      kind: data.kind,
      role,
      displayName: data.displayName,
      defaultRepo: data.defaultRepo,
      defaultTeamId: data.defaultTeamId,
      reviewRepo: data.reviewRepo,
      maxConcurrentIssues: data.maxConcurrentIssues ?? 1,
      maxReviewAttempts: data.maxReviewAttempts ?? 2,
      enabled: data.enabled ?? true,
      autonomousMode: data.autonomousMode ?? false,
      createdAt: new Date().toISOString(),
    };
    await db.collection('agents').doc(data.agentId).set(cleanUndefined(agent));

    const memberId = `${data.workspaceId}_${data.agentId}`;
    const member = {
      id: memberId,
      workspaceId: data.workspaceId,
      userId: data.agentId,
      email: `${data.agentId}@agents.pulse.local`,
      displayName: data.displayName,
      role: 'member',
      isAgent: true,
      agentKind: data.kind,
      agentRole: role,
      joinedAt: new Date().toISOString(),
    };
    await db.collection('members').doc(memberId).set(cleanUndefined(member));

    return { agent, member };
  }
}
