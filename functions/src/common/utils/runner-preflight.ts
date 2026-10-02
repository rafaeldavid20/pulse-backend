import { isRunnerAvailable, RUNNER_HEARTBEAT_TTL_MS } from './runner-availability';
import { agentAllowedRepos, agentVisibility } from './agent-authorization';

export interface RunnerReadiness {
  workspaceId: string;
  identities: Array<{ agentId: string; kind: 'codex' | 'claude'; role: 'dev' | 'qa' }>;
  providers: { codex: { cli: boolean; session: boolean }; claude: { cli: boolean; session: boolean } };
  repositories: Array<{ repo: string; accessible: boolean }>;
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
  return { workspaceId: value.workspaceId, identities, providers, repositories };
}

export function runnerPreflight(agent: any, runner: any, workspaceId: string, repos: string[], mode: string, now = Date.now()) {
  const problems: Array<{ code: string; message: string; action: string }> = [];
  const fail = (code: string, message: string, action: string) => problems.push({ code, message, action });
  if (!agent || agent.workspaceId !== workspaceId || agent.archivedAt || !agent.enabled) fail('agent', 'El agente no está habilitado en este workspace.', 'Habilitá o restaurá el agente en Ajustes.');
  if (!runner || runner.workspaceId !== workspaceId || agent?.runnerId !== runner?.id) fail('binding', 'Falta un vínculo válido entre agente y Runner.', 'Seleccioná un Runner de este workspace en Ajustes del agente.');
  if (!runner || !isRunnerAvailable(runner, now)) fail('runner', 'El Runner no está disponible.', 'Iniciá pulse-runner start y esperá un heartbeat reciente; revisá si está ocupado o revocado.');
  if (agent && runner && agentVisibility(agent) === 'personal' && agent.ownerMemberId !== runner.ownerMemberId) fail('owner', 'El Runner no pertenece al dueño del agente.', 'Vinculá un Runner del mismo dueño.');
  const role = mode === 'review' ? 'qa' : 'dev';
  if (agent?.role !== role) fail('role', 'El rol del agente es incompatible con el job.', 'Usá un agente QA para revisiones y Dev para tareas.');
  const readiness = runner?.readiness as RunnerReadiness | undefined;
  const checked = Date.parse(runner?.readinessCheckedAt || '');
  if (!readiness || !Number.isFinite(checked) || checked > now || now - checked > RUNNER_HEARTBEAT_TTL_MS) fail('readiness', 'La preparación local no tiene una verificación reciente.', 'Actualizá el Runner y ejecutá pulse-runner diagnose; luego reintentá la verificación.');
  const identity = readiness?.identities?.find((entry) => entry.agentId === agent?.id);
  if (readiness?.workspaceId !== workspaceId || !identity || identity.kind !== agent?.kind || identity.role !== role) fail('identity', 'La identidad local no coincide con agente, proveedor y rol de Pulse.', 'En la máquina del Runner ejecutá pulse-runner identity add --agent ID --agent-kind codex|claude --agent-role dev|qa con los valores de este agente.');
  const provider = readiness?.providers?.[agent?.kind as 'codex' | 'claude'];
  if (!provider?.cli) fail('cli', 'El CLI del proveedor no está disponible.', 'Instalá el CLI de Codex o Claude en la máquina del Runner y reiniciá el servicio.');
  if (!provider?.session) fail('session', 'No hay una sesión local utilizable del proveedor.', agent?.kind === 'claude' ? 'Ejecutá claude auth login en la máquina y usuario del Runner; luego pulse-runner diagnose.' : 'Ejecutá codex login en la máquina y usuario del Runner; luego pulse-runner diagnose.');
  if (!repos.length) fail('repository', 'No hay repositorio para verificar.', 'Configurá un repo permitido para el agente.');
  for (const repo of repos) {
    if (!runner?.connectedRepos?.includes(repo) || (role !== 'qa' && !agentAllowedRepos(agent || {}).includes(repo))) fail('repository', `El repo ${repo} no está autorizado.`, 'Conectá el repo al agente y agregalo con pulse-runner repo add owner/repo.');
    if (!readiness?.repositories?.some((entry) => entry.repo === repo && entry.accessible)) fail('repository_access', `El Runner no tiene acceso local a ${repo}.`, 'Revisá las credenciales Git locales y ejecutá pulse-runner diagnose.');
  }
  return { ready: problems.length === 0, problems, identity: identity || null, checkedAt: runner?.readinessCheckedAt || null };
}
