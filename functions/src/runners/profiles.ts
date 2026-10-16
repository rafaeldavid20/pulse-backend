import { Firestore, Transaction } from 'firebase-admin/firestore';
import { canManageAgent, isWorkspaceAdmin } from '../common/utils/agent-authorization';
import { runnerProjectRepoAccess } from '../common/utils/project-repos';
import { profileInput, profileKey, profileOnline, profileSnapshot, profileResult } from '../common/utils/runner-profile-contract';

// Read the same project/installation intersection used by signed dispatch.
async function context(db: Firestore, tx: Transaction, runnerId: string, agentId: string, actor?: string) {
  const agent = (await tx.get(db.collection('agents').doc(agentId))).data();
  const runner = (await tx.get(db.collection('runners').doc(runnerId))).data();
  if (!agent || !runner || agent.archivedAt || runner.revokedAt || agent.workspaceId !== runner.workspaceId || agent.runnerId !== runnerId) throw new Error('Vínculo de Runner no autorizado.');
  if (actor) {
    const member = (await tx.get(db.collection('members').doc(`${agent.workspaceId}_${actor}`))).data();
    const admin = isWorkspaceAdmin(member || null);
    if (!member || !canManageAgent(agent, actor, admin) || (!admin && agent.ownerMemberId !== actor) || (runner.ownerMemberId !== actor && !admin)) throw new Error('Solo el dueño o un admin puede administrar agente y Runner.');
  }
  const installations = await tx.get(db.collection('github_installations').where('workspaceId', '==', agent.workspaceId));
  const installed = installations.docs.flatMap(d => d.data().suspendedAt ? [] : d.data().repositoryFullNames || []);
  const projects = await tx.get(db.collection('projects').where('workspaceId', '==', agent.workspaceId));
  const repos = new Set<string>();
  for (const p of projects.docs) {
    // Reuse dispatch's strict resolver, within this transaction's read set.
    const access = await runnerProjectRepoAccess(db, { workspaceId: agent.workspaceId, projectId: p.id }, installed, tx);
    access?.repos.forEach(repo => repos.add(repo));
  }
  const sorted = [...repos].sort();
  const binding = profileKey(agent.profileBinding || '', runnerId, agent.kind, agent.role || 'dev', agent.ownerMemberId || '', agent.visibility || 'public', JSON.stringify(sorted));
  return { workspaceId: agent.workspaceId as string, agentId, runnerId, provider: agent.kind as string, role: agent.role || 'dev', repos: sorted, binding, online: profileOnline(runner), capable: runner.profileVersion === 1 };
}

const refFor = (db: Firestore, c: any) => db.collection('runner_profiles').doc(profileKey(c.workspaceId, c.agentId, c.runnerId));
const requestRef = (db: Firestore, c: any, id: string) => db.collection('runner_profile_requests').doc(profileKey(c.workspaceId, c.agentId, c.runnerId, id));

export async function manageRunnerProfile(db: Firestore, actor: string, raw: unknown) {
  const parsed = profileInput.safeParse(raw);
  if (!parsed.success) throw new Error('Solicitud de perfil inválida.');
  const input = parsed.data;
  return db.runTransaction(async tx => {
    const c = await context(db, tx, input.runnerId, input.agentId, actor);
    const stored = (await tx.get(refFor(db, c))).data();
    const confirmed = stored?.binding === c.binding ? stored : null;
    const existing = input.requestId ? (await tx.get(requestRef(db, c, input.requestId))).data() : null;
    if (input.op === 'read') {
      // Discover uncertainty across clients, including clients without local storage.
      // Prefer the active command even if the caller remembers an older terminal ID.
      const queued = await tx.get(db.collection('runner_profile_requests').where('runnerId', '==', c.runnerId));
      const unresolved = queued.docs.map(d => d.data()).find(r => r.workspaceId === c.workspaceId && r.agentId === c.agentId && r.binding === c.binding && r.status === 'applying');
      const request = unresolved || (existing?.binding === c.binding ? existing : null);
      return { ...c, snapshot: confirmed?.snapshot || null, observedAt: confirmed?.observedAt || null, request: request ? { id: request.requestId, status: request.status } : null };
    }
    if (!input.requestId || !input.expectedRevision || !input.patch) throw new Error('Falta ID, revisión o patch.');
    if (existing) {
      if (existing.binding !== c.binding || existing.actor !== actor || JSON.stringify(existing.patch) !== JSON.stringify(input.patch) || existing.expectedRevision !== input.expectedRevision) throw new Error('ID de solicitud ya utilizado.');
      return { requestId: input.requestId, status: existing.status };
    }
    if (!c.online || !c.capable || !confirmed || Date.now() - Date.parse(confirmed.observedAt) > 120_000) throw new Error('Runner desconectado, incompatible o sin perfil reciente. Recargá.');
    if (confirmed.snapshot.revision !== input.expectedRevision) throw new Error('Conflicto de revisión. Recargá el perfil.');
    const snapshot = profileSnapshot.parse(confirmed.snapshot);
    if (input.patch.model && !snapshot.models.includes(input.patch.model)) throw new Error('Modelo no disponible.');
    const seen = new Set<string>();
    for (const entry of input.patch.directories || []) {
      const repo = snapshot.directories.find(r => r.repo === entry.repo);
      if (seen.has(entry.repo) || !c.repos.includes(entry.repo) || !repo || (entry.candidateId && !repo.candidates.some(d => d.id === entry.candidateId))) throw new Error('Candidato no autorizado.');
      seen.add(entry.repo);
    }
    const pending = await tx.get(db.collection('runner_profile_requests').where('runnerId', '==', c.runnerId));
    if (pending.docs.some(d => d.data().agentId === c.agentId && d.data().binding === c.binding && d.data().status === 'applying')) throw new Error('Hay una solicitud incierta. Consultá su resultado antes de editar.');
    const now = new Date().toISOString();
    tx.set(requestRef(db, c, input.requestId), { ...c, ...input, actor, status: 'applying', createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    return { requestId: input.requestId, status: 'applying' };
  });
}

/** Device-authenticated exchange. Neither this service nor its audit stores raw input. */
export async function exchangeRunnerProfiles(db: Firestore, runnerId: string, body: any) {
  if (body.version !== 1 || !Array.isArray(body.agentIds) || body.agentIds.length > 50 || body.agentIds.some((id: any) => typeof id !== 'string' || !/^[-A-Za-z0-9_]{1,100}$/.test(id))) throw new Error('Invalid identities');
  const contexts = [];
  for (const agentId of [...new Set<string>(body.agentIds)]) {
    try {
      const value = await db.runTransaction(async tx => {
        const c = await context(db, tx, runnerId, agentId);
        const stored = (await tx.get(refFor(db, c))).data();
        const queued = await tx.get(db.collection('runner_profile_requests').where('runnerId', '==', runnerId));
        const requests: Array<FirebaseFirestore.DocumentData & { permitted: boolean }> = [];
        for (const doc of queued.docs) {
          const request = doc.data();
          if (request.agentId !== agentId || request.binding !== c.binding || request.status !== 'applying') continue;
          // Recheck the human's authority before every delivery, including retries.
          let permitted = true;
          try { await context(db, tx, runnerId, agentId, request.actor); } catch { permitted = false; }
          requests.push({ ...request, permitted });
        }
        const incoming = body.profiles?.find((p: any) => p.agentId === agentId && p.binding === c.binding);
        const snapshot = incoming ? profileSnapshot.parse(incoming.snapshot) : null;
        if (snapshot && (snapshot.provider !== c.provider || snapshot.directories.some(r => !c.repos.includes(r.repo)))) throw new Error('Invalid scope');
        const result = incoming?.result ? profileResult.parse(incoming.result) : null;
        const request = result && requests.find(r => r.requestId === result.requestId);
        if (result && (!request || !request.permitted || (result.status === 'applied' && (!snapshot || !result.revision)))) throw new Error('Invalid confirmation');
        const now = new Date().toISOString();
        if (snapshot) tx.set(refFor(db, c), { binding: c.binding, snapshot, observedAt: now });
        for (const request of requests) {
          if (!request.permitted) tx.update(requestRef(db, c, request.requestId), { status: 'forbidden', completedAt: now });
        }
        if (result) tx.update(requestRef(db, c, result.requestId), { status: result.status, completedAt: now, ...(result.revision ? { revision: result.revision } : {}) });
        // Applied acknowledgements remain retrievable by ID; they are never inferred from a snapshot.
        return { ...c, requests: requests.filter(r => c.online && c.capable && r.permitted && r.requestId !== result?.requestId).map(r => ({ version: 1, workspaceId: c.workspaceId, agentId, runnerId, binding: c.binding, provider: c.provider, repos: c.repos, requestId: r.requestId, expectedRevision: r.expectedRevision, patch: r.patch, expiresAt: r.expiresAt })), observed: !!snapshot || !!stored };
      });
      contexts.push(value);
    } catch { /* Removed/rebound identities receive no profile or commands. */ }
  }
  await db.collection('runners').doc(runnerId).update({ profileVersion: 1 });
  return { version: 1, contexts };
}
