import { Firestore } from 'firebase-admin/firestore';

/**
 * Centraliza las reglas de TES-284. Las actions y el trigger las comparten
 * porque validar solo en la UI permitiría saltarse ownership vía MCP/callable.
 */
export async function getWorkspaceMember(db: Firestore, workspaceId: string, userId: string) {
  const snap = await db.collection('members').doc(`${workspaceId}_${userId}`).get();
  return snap.exists ? snap.data()! : null;
}

export function isWorkspaceAdmin(member: Record<string, any> | null): boolean {
  return member?.role === 'owner' || member?.role === 'admin';
}

/** The public creator remains the owner of that shared agent. Workspace admins
 * may moderate personal agents, but cannot delete a public agent created by a
 * different admin. Legacy ownerless agents remain admin-manageable. */
export function canDeleteAgent(
  agent: { ownerMemberId?: string; visibility?: string },
  callerUid: string,
  callerIsAdmin: boolean,
): boolean {
  if (agentVisibility(agent as Record<string, any>) === 'public' && agent.ownerMemberId) {
    return agent.ownerMemberId === callerUid;
  }
  return callerIsAdmin || !agent.ownerMemberId || agent.ownerMemberId === callerUid;
}

export function agentVisibility(agent: Record<string, any>): 'personal' | 'public' {
  // Los agentes anteriores no tenían dueño: solo los admins los pueden seguir
  // usando hasta que un admin les asigne un owner explícito.
  return agent.visibility ?? 'public';
}

export function agentAllowedRepos(agent: Record<string, any>): string[] {
  if (Array.isArray(agent.allowedRepos) && agent.allowedRepos.length > 0) return agent.allowedRepos;
  return (agent.connectedRepos || []).map((connection: Record<string, any>) => connection.repoFullName).filter(Boolean);
}

/** Política pura, reutilizable y testeable para agentes personales/públicos. */
export function canManageAgent(
  agent: { ownerMemberId?: string; visibility?: string },
  callerUid: string,
  callerIsAdmin: boolean,
): boolean {
  if (agentVisibility(agent as Record<string, any>) === 'public') return callerIsAdmin;
  return callerIsAdmin || !agent.ownerMemberId || agent.ownerMemberId === callerUid;
}

export function canAssignExecutionAgent(
  agent: { ownerMemberId?: string; visibility?: string },
  callerUid: string,
  responsibleMemberId: string,
): boolean {
  // Public agents are reserved for workspace assignment processes. This action
  // is the manual issue assignment path, so only the private agent's owner may
  // use it, and only on an issue they own.
  if (agentVisibility(agent as Record<string, any>) === 'public') return false;
  return agent.ownerMemberId === callerUid && responsibleMemberId === callerUid;
}
