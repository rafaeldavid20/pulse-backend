import { Firestore } from 'firebase-admin/firestore';

/**
 * A qué repo de GitHub pertenece un issue.
 *
 * Se resuelve en cascada, de lo más específico a lo más general:
 *
 *   1. el repo propio del issue        (`git.repoFullName`)
 *   2. el repo por defecto de su épica (`git.repoFullName` de la épica)
 *   3. el repo por defecto del agente  (`agents/{id}.defaultRepo`)
 *   4. el único repo de la instalación, si hay exactamente uno
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
  source: 'issue' | 'epic' | 'agent' | 'installation' | 'none';
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
  if (agentId) {
    const agentSnap = await db.collection('agents').doc(agentId).get();
    const agentRepo = agentSnap.exists ? agentSnap.data()!.defaultRepo : undefined;
    if (agentRepo) return { repoFullName: agentRepo, source: 'agent' };
  }

  if (opts.installationRepos?.length === 1) {
    return { repoFullName: opts.installationRepos[0], source: 'installation' };
  }

  return { source: 'none' };
}
