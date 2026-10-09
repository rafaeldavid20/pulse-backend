import { isRunnerAvailable, RUNNER_HEARTBEAT_TTL_MS } from './runner-availability';
import { agentAllowedRepos, agentVisibility } from './agent-authorization';

export interface RunnerReadiness {
  workspaceId: string;
  identities: Array<{ agentId: string; kind: 'codex' | 'claude'; role: 'dev' | 'qa' }>;
  providers: { codex: { cli: boolean; session: boolean }; claude: { cli: boolean; session: boolean } };
  repositories: Array<{ repo: string; accessible: boolean }>;
  jobProtocolVersion?: 2 | 3;
  prPublicationModeVersion?: 1;
  githubApps?: Array<{projectId: string; repo: string; appId: string; installationId: string; slug: string; base?: string; ready: boolean}>;
  qaSourceProtocolVersion?: 1;
}

/** Explicit allow-list: CLI output, account data and credentials never reach storage. */
export function parseRunnerReadiness(value: any): RunnerReadiness {
  if (!value || typeof value.workspaceId !== 'string' || !Array.isArray(value.identities) || value.identities.length > 50 || !Array.isArray(value.repositories) || value.repositories.length > 100) throw new Error('Invalid Runner readiness.');
  const identities = value.identities.map((identity: any) => {
    if (!identity || !/^[-A-Za-z0-9_]{1,100}$/.test(identity.agentId) || !['codex', 'claude'].includes(identity.kind) || !['dev', 'qa'].includes(identity.role)) throw new Error('Invalid Runner identity.');
    return { agentId: identity.agentId, kind: identity.kind, role: identity.role };
  });
  const providers = {} as RunnerReadiness['providers'];
  for (const kind of ['codex', 'claude'] as const) {
    if (typeof value.providers?.[kind]?.cli !== 'boolean' || typeof value.providers?.[kind]?.session !== 'boolean') throw new Error('Invalid provider readiness.');
    providers[kind] = { cli: value.providers[kind].cli, session: value.providers[kind].session };
  }
  const repositories = value.repositories.map((entry: any) => {
    if (!entry || typeof entry.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo) || typeof entry.accessible !== 'boolean') throw new Error('Invalid repository readiness.');
    return { repo: entry.repo, accessible: entry.accessible };
  });
  if (value.jobProtocolVersion !== undefined && !([2, 3].includes(value.jobProtocolVersion))) throw new Error('Invalid Runner job protocol.');
  if (value.prPublicationModeVersion !== undefined && value.prPublicationModeVersion !== 1) throw new Error('Invalid PR publication mode version.');
  if (value.qaSourceProtocolVersion !== undefined && value.qaSourceProtocolVersion !== 1) throw new Error('Invalid QA source protocol.');
  const githubApps = value.githubApps === undefined ? [] : value.githubApps;
  if (!Array.isArray(githubApps) || githubApps.length > 100) throw new Error('Invalid GitHub App readiness.');
  const seen = new Set<string>();
  const safeApps = githubApps.map((e: any) => {
    if (!e || !/^[-A-Za-z0-9_]{1,100}$/.test(e.projectId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.repo) || !/^\d+$/.test(e.appId) || !/^\d+$/.test(e.installationId) || !/^[-A-Za-z0-9_]{1,100}$/.test(e.slug) || typeof e.ready !== 'boolean' || (e.ready && (typeof e.base !== 'string' || e.base.length > 200))) throw new Error('Invalid GitHub App readiness.');
    const key = `${e.projectId}:${e.repo}`;
    if (seen.has(key)) throw new Error('Duplicate GitHub App binding.');
    seen.add(key);
    return { projectId: e.projectId, repo: e.repo, appId: e.appId, installationId: e.installationId, slug: e.slug, ready: e.ready, ...(e.ready ? {base: e.base} : {}) };
  });
  return { ...(value.prPublicationModeVersion === 1 ? { prPublicationModeVersion: 1 as const } : {}), githubApps: safeApps, workspaceId: value.workspaceId, identities, providers, repositories, ...(value.qaSourceProtocolVersion === 1 ? { qaSourceProtocolVersion: 1 as const } : {}), ...([2, 3].includes(value.jobProtocolVersion) ? { jobProtocolVersion: value.jobProtocolVersion as 2 | 3 } : {}) };
}

export function runnerPreflight(agent: any, runner: any, workspaceId: string, repos: string[], mode: string, now = Date.now(), projectScoped = false, publicationOnly = false) {
  const problems: Array<{ code: string; message: string; action: string }> = [];
  const fail = (code: string, message: string, action: string) => problems.push({ code, message, action });
  if (!agent || agent.workspaceId !== workspaceId || agent.archivedAt || !agent.enabled) fail('agent', 'El agente no está habilitado en este workspace.', 'Habilitá o restaurá el agente en Ajustes.');
  if (!runner || runner.workspaceId !== workspaceId || agent?.runnerId !== runner?.id) fail('binding', 'Falta un vínculo válido entre agente y Runner.', 'Seleccioná un Runner de este workspace en Ajustes del agente.');
  if (!runner || !isRunnerAvailable(runner, now)) fail('runner', 'El Runner no está disponible.', 'Iniciá pulse-runner start y esperá un heartbeat reciente; revisá si está ocupado o revocado.');
  if (agent && runner && agentVisibility(agent) === 'personal' && agent.ownerMemberId !== runner.ownerMemberId) fail('owner', 'El Runner no pertenece al dueño del agente.', 'Vinculá un Runner del mismo dueño.');
  const role = mode === 'review' ? 'qa' : 'dev';
  if (agent?.role !== role) fail('role', 'El rol del agente es incompatible con el job.', 'Usá un agente QA para revisiones y Dev para tareas.');
  const readiness = runner?.readiness as RunnerReadiness | undefined;
  if (projectScoped && ![2, 3].includes(readiness?.jobProtocolVersion || 0)) fail('runner_upgrade', 'El Runner instalado no admite jobs autorizados por proyecto.', 'En la máquina del Runner ejecutá npm install -g @pulsehub/runner@latest, reinstalá/reiniciá el servicio y ejecutá pulse-runner diagnose. Se conserva el pairing y la clave existentes.');
  if (!publicationOnly && role === 'dev' && agent?.prPublicationMode === 'ready' && (readiness?.jobProtocolVersion !== 3 || readiness?.prPublicationModeVersion !== 1)) fail('pr_publication_upgrade', 'El Runner instalado no admite publicar PR listos para revisión.', 'Actualizá @pulsehub/runner a la última versión y reiniciá el servicio.');
  if (projectScoped && role === 'qa' && readiness?.qaSourceProtocolVersion !== 1) fail('qa_source_upgrade', 'El Runner instalado no admite snapshots QA sin credenciales Git globales.', 'Actualizá @pulsehub/runner a 0.1.8 o superior y reiniciá el servicio.');
  if (role === 'dev' && readiness?.jobProtocolVersion === 3 && (!readiness.githubApps?.some(e => e.ready))) fail('github_app', 'La GitHub App local requiere configuración o permisos de publicación.', 'Configurá github-app por proyecto y repo en la máquina del Runner; luego ejecutá pulse-runner diagnose.');
  const checked = Date.parse(runner?.readinessCheckedAt || '');
  if (!readiness || !Number.isFinite(checked) || checked > now || now - checked > RUNNER_HEARTBEAT_TTL_MS) fail('readiness', 'La preparación local no tiene una verificación reciente.', 'Actualizá el Runner y ejecutá pulse-runner diagnose; luego reintentá la verificación.');
  const identity = readiness?.identities?.find((entry) => entry.agentId === agent?.id);
  if (readiness?.workspaceId !== workspaceId || !identity || identity.kind !== agent?.kind || identity.role !== role) fail('identity', 'La identidad local no coincide con agente, proveedor y rol de Pulse.', 'En la máquina del Runner ejecutá pulse-runner identity add --agent ID --agent-kind codex|claude --agent-role dev|qa con los valores de este agente.');
  const provider = readiness?.providers?.[agent?.kind as 'codex' | 'claude'];
  if (!publicationOnly && !provider?.cli) fail('cli', 'El CLI del proveedor no está disponible.', 'Instalá el CLI de Codex o Claude en la máquina del Runner y reiniciá el servicio.');
  if (!publicationOnly && !provider?.session) fail('session', 'No hay una sesión local utilizable del proveedor.', agent?.kind === 'claude' ? 'Ejecutá claude auth login en la máquina y usuario del Runner; luego pulse-runner diagnose.' : 'Ejecutá codex login en la máquina y usuario del Runner; luego pulse-runner diagnose.');
  if (!projectScoped && !repos.length) fail('repository', 'No hay repositorio para verificar.', 'Configurá un repo permitido para el agente.');
  for (const repo of projectScoped ? [] : repos) {
    if (!runner?.connectedRepos?.includes(repo) || (role !== 'qa' && !agentAllowedRepos(agent || {}).includes(repo))) fail('repository', `El repo ${repo} no está autorizado.`, 'Conectá el repo al agente y agregalo con pulse-runner repo add owner/repo.');
    if (!readiness?.repositories?.some((entry) => entry.repo === repo && entry.accessible)) fail('repository_access', `El Runner no tiene acceso local a ${repo}.`, 'Revisá las credenciales Git locales y ejecutá pulse-runner diagnose.');
  }
  return { ready: problems.length === 0, problems, githubApps: readiness?.githubApps || [], identity: identity || null, checkedAt: runner?.readinessCheckedAt || null };
}

/** Persist preparation failures before reserving a task, rework or handoff. */
export async function runnerPreflightForDispatch(db: FirebaseFirestore.Firestore, issueId: string, agent: any, runner: any, workspaceId: string, repos: string[], mode: string) {
  const check = runnerPreflight(agent, runner, workspaceId, repos, mode, Date.now(), true);
  if (!check.ready) await db.collection('issues').doc(issueId).update({
    'agent.state': 'blocked',
    'agent.blockedReason': check.problems.map((problem) => `${problem.message} ${problem.action}`).join(' '),
    updatedAt: new Date().toISOString(),
  });
  return check.ready;
}
