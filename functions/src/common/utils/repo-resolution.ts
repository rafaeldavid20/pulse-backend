import { Firestore } from 'firebase-admin/firestore';

/**
 * A qué repo de GitHub pertenece un issue.
 *
 * Se resuelve en cascada, de lo más específico a lo más general:
 *
 *   1. el repo propio del issue        (`git.repoFullName`)
 *   2. el repo por defecto de su épica (`git.repoFullName` de la épica)
 *   3. el repo por defecto del agente  (`agents/{id}.defaultRepo`)
 *   4. el primer repo permitido, en el orden definido por su proyecto
 *   5. el único repo de la instalación, si hay exactamente uno
 *
 * El orden importa y antes estaba invertido: `agentDispatchTrigger` hacía
 * `agent.defaultRepo || issue.git?.repoFullName`, con lo cual el default del
 * agente le ganaba al valor puesto explícitamente en el issue — o sea que el
 * override por issue no se podía usar. Un default es lo que aplica cuando no
 * dijiste nada; nunca debería pisar lo que sí dijiste.
 *
 * `create-branch` tenía el mismo problema por otra vía: resolvía
 * `data.repoFullName -> agent.defaultRepo -> único repo`, sin mirar nunca al
 * issue ni a su épica.
 */

export interface RepoResolution {
  repoFullName?: string;
  /** De dónde salió, para poder explicarlo en la UI y en los logs. */
  source: 'issue' | 'epic' | 'agent' | 'project' | 'installation' | 'none';
}

export async function resolveIssueRepo(
  db: Firestore,
  issue: FirebaseFirestore.DocumentData,
  opts: {
    /** Repo pedido explícitamente en la llamada; gana sobre todo lo demás. */
    explicitRepo?: string;
    /** Agente cuyo `defaultRepo` usar. Por defecto, el asignado del issue. */
    agentId?: string;
    /** Repos autorizados de la instalación de GitHub del workspace. */
    installationRepos?: string[];
  } = {}
): Promise<RepoResolution> {
  if (opts.explicitRepo) {
    return { repoFullName: opts.explicitRepo, source: 'issue' };
  }

  if (issue.git?.repoFullName) {
    return { repoFullName: issue.git.repoFullName, source: 'issue' };
  }

  // La épica del issue. `epicId` está denormalizado, así que es una lectura
  // sola sin importar la profundidad a la que cuelgue.
  if (issue.epicId) {
    const epicSnap = await db.collection('issues').doc(issue.epicId).get();
    const epicRepo = epicSnap.exists ? epicSnap.data()!.git?.repoFullName : undefined;
    if (epicRepo) return { repoFullName: epicRepo, source: 'epic' };
  }

  const agentId = opts.agentId ?? issue.assigneeId;
  let agentAllowedRepos: string[] = [];
  if (agentId) {
    const agentSnap = await db.collection('agents').doc(agentId).get();
    const agent = agentSnap.exists ? agentSnap.data()! : undefined;
    const agentRepo = agent?.defaultRepo;
    if (agentRepo) return { repoFullName: agentRepo, source: 'agent' };
    agentAllowedRepos = Array.isArray(agent?.allowedRepos) && agent.allowedRepos.length > 0
      ? agent.allowedRepos
      : (agent?.connectedRepos || []).map((connection: Record<string, any>) => connection.repoFullName).filter(Boolean);
  }

  // Los repos del proyecto son el ámbito que el usuario ya configuró. Cuando
  // no hay un override más específico, el primero compatible en ese orden es
  // el repositorio primario del job; los restantes llegan como contexto del
  // Runner y un cambio que requiera otro PR se deriva como handoff.
  if (issue.projectId) {
    const projectSnap = await db.collection('projects').doc(issue.projectId).get();
    const projectRepos: string[] = projectSnap.exists ? projectSnap.data()!.repoFullNames || [] : [];
    const candidates = projectRepos.filter((repo) =>
      (!opts.installationRepos?.length || opts.installationRepos.includes(repo)) &&
      (agentAllowedRepos.length === 0 || agentAllowedRepos.includes(repo))
    );
    if (candidates.length > 0) return { repoFullName: candidates[0], source: 'project' };
  }

  if (opts.installationRepos?.length === 1) {
    return { repoFullName: opts.installationRepos[0], source: 'installation' };
  }

  return { source: 'none' };
}
