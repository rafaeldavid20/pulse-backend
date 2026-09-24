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

export function agentVisibility(agent: Record<string, any>): 'personal' | 'public' {
  // Los agentes anteriores no tenían dueño: solo los admins los pueden seguir
  // usando hasta que un admin les asigne un owner explícito.
  return agent.visibility ?? 'public';
}

export function agentAllowedRepos(agent: Record<string, any>): string[] {
  if (Array.isArray(agent.allowedRepos) && agent.allowedRepos.length > 0) return agent.allowedRepos;
  return (agent.connectedRepos || []).map((connection: Record<string, any>) => connection.repoFullName).filter(Boolean);
}

