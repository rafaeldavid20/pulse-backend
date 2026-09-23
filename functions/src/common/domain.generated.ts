// ============================================================
// GENERADO — NO EDITAR A MANO.
//
// Copia de `pulse-app/src/types/domain.ts`, la fuente única del modelo de
// dominio de Pulse. Para cambiar algo de acá, editá ese archivo y corré
// `npm run sync:types` desde `pulse-app`.
//
// SOURCE_HASH: 1b4ab10913c3e734
// ============================================================

/**
 * FUENTE ÚNICA DEL MODELO DE DOMINIO DE PULSE.
 *
 * Este archivo es la verdad para *ambos* repos. `pulse-backend` consume una
 * copia generada en `functions/src/common/domain.generated.ts`; para
 * regenerarla, desde `pulse-app`:
 *
 *     npm run sync:types
 *
 * `npm run lint` falla si la copia quedó desincronizada.
 *
 * REGLA: este módulo no importa nada. Ni `firebase`, ni `firebase-admin`, ni
 * tipos de React. Se copia literal a un proyecto TypeScript distinto, con otro
 * `tsconfig` y otro árbol de dependencias — cualquier import lo rompe del otro
 * lado. Las fechas son strings ISO 8601, no `Timestamp` ni `Date`, por el mismo
 * motivo.
 *
 * Lo que NO va acá: `FilterState` y demás estado de UI (solo pulse-app), y
 * `PlatformAction*` (solo pulse-backend).
 */

// ---------------------------------------------------------------------------
// Enumeraciones
// ---------------------------------------------------------------------------

export type IssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled';

/** 0: Sin prioridad, 1: Urgente, 2: Alta, 3: Media, 4: Baja */
export type IssuePriority = 0 | 1 | 2 | 3 | 4;

/**
 * Nivel del issue dentro de la jerarquía. Una épica no es una colección
 * aparte: es un issue con `type: 'epic'`, así hereda identificador, estado,
 * comentarios e historial sin duplicar la mitad del modelo.
 */
export type IssueType = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

export type ProjectStatus =
  | 'planned'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'canceled';

export type MemberRole = 'owner' | 'admin' | 'member';

export type CycleStatus = 'upcoming' | 'active' | 'completed';

export type AgentKind = 'claude' | 'chatgpt';

/** 'dev' abre PRs sobre issues; 'qa' los revisa contra criterios explícitos. */
export type AgentRole = 'dev' | 'qa';

export type AgentIssueState = 'idle' | 'claimed' | 'working' | 'pr_open' | 'blocked';

/**
 * Default `'shadow'` al crear un agente `qa` (D17). En `shadow` el veredicto
 * se registra completo pero no mueve el issue: sirve para calibrar si el
 * criterio del QA coincide con el humano antes de dejarlo actuar. Pasar a
 * `enforce` es una decisión explícita en Settings (`agents.update`).
 */
export type AgentQaMode = 'shadow' | 'enforce';

/** Camino de dispatch que originó el run (D15). */
export type AgentRunMode = 'task' | 'rework' | 'handoff' | 'review';

/**
 * Cómo terminó un run (D15). `failed`/`timeout` cubren los runs que no
 * llegan a ningún cierre limpio — sin ellos el costo de esos runs quedaría
 * fuera de cualquier total.
 */
export type AgentRunOutcome =
  | 'pr_opened'
  | 'verdict_submitted'
  | 'released'
  | 'ambiguous'
  | 'failed'
  | 'timeout';

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
  /**
   * Kill switch global (D8/TES-153): en `true`, corta los cuatro caminos de
   * dispatch de agentes (task, traspaso, re-trabajo y revisión) sin tocar
   * `enabled`/`autonomousMode` de cada agente.
   */
  agentsPaused?: boolean;
  /** Override por workspace del tope diario compartido de dispatches. Default `DAILY_DISPATCH_LIMIT` (5) si no está seteado. */
  dailyDispatchLimit?: number;
  /** Techo de gasto diario del workspace en USD, sumando `agent_runs.costUsd` (D15) de hoy. Sin tope si no está seteado. */
  dailyCostCapUsd?: number;
  /** Techo de gasto por issue en USD, sumando `agent_runs.costUsd` (D15) de ese issue. Sin tope si no está seteado. */
  issueCostCapUsd?: number;
  /** Tope de runs (dev + QA + traspasos) por issue antes de pasarlo a `needs_human`. Default `DEFAULT_MAX_RUNS_PER_ISSUE` (6) si no está seteado. */
  maxRunsPerIssue?: number;
}

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  /** Prefijo del identificador de issue, ej. "ENG" en "ENG-142". */
  key: string;
  icon?: string;
  issueCount: number;
  createdAt: string;
  /** Ausente equivale a `{ enabled: false, autoCreate: false, ... }`: sin ciclos ni auto-creación. */
  cycleSettings?: CycleSettings;
}

/**
 * Configuración de ciclos por equipo (E4). `enabled` es el flag maestro — en
 * `false` el equipo no usa ciclos, y el resto de los campos no importa.
 * `autoCreate`, aparte y no implícito en `enabled`, es lo que habilita el
 * scheduler que crea el siguiente ciclo solo: un equipo puede querer ciclos
 * sin que nadie tenga que planificarlos automáticamente.
 */
export interface CycleSettings {
  enabled: boolean;
  /** Duración de cada ciclo, en semanas. */
  lengthWeeks: 1 | 2 | 3 | 4;
  /** Día en que arranca cada ciclo — `Date.getUTCDay()`: 0 domingo .. 6 sábado. */
  startDayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  autoCreate: boolean;
}

export interface Label {
  id: string;
  teamId: string;
  name: string;
  color: string;
}

/**
 * Qué clase de proyecto es (O15/TES-270). Decide qué superficie específica
 * aparece: un workspace ve la configuración de Salesforce (entornos, orgs,
 * tools `pulse_sf_*`) sólo si tiene al menos un proyecto `salesforce`. Es un
 * `kind` y no un booleano porque el mismo campo va a elegir la plantilla de
 * estados (épica N) y los skills del agente (épica M).
 */
export type ProjectKind = 'generic' | 'salesforce';

export const PROJECT_KINDS: readonly ProjectKind[] = ['generic', 'salesforce'];

export interface Project {
  id: string;
  teamId: string;
  name: string;
  description: string;
  status: ProjectStatus;
  /** Ausente en los proyectos anteriores a TES-270: se lee como `'generic'`. */
  kind?: ProjectKind;
  /**
   * Repos en los que se puede trabajar este proyecto. Es el límite: al crear una
   * rama, tanto una persona como un agente eligen libremente *dentro* de este
   * conjunto. Vacío o ausente significa "cualquiera de la instalación", para no
   * romper los proyectos anteriores a este campo.
   */
  repoFullNames?: string[];
  leadId?: string;
  color?: string;
  targetDate?: string;
  /**
   * Reglas que valen para todos los issues del proyecto (D14), a diferencia
   * de `Issue.acceptanceCriteria` que es por issue. El QA las verifica
   * siempre, además de la rúbrica del issue puntual — un finding que viola
   * una de estas referencia `ReviewFinding.dodId` en vez de `criterionId`.
   * Ausente o vacío: sin reglas de proyecto además de las del issue.
   */
  definitionOfDone?: DefinitionOfDoneCriterion[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Un ítem de la Definition of Done de un proyecto (D14). A diferencia de
 * `AcceptanceCriterion`, no tiene `source`/`accepted`: no hay propuesta de IA
 * ni aceptación manual acá, todos los ítems valen apenas se guardan. Tampoco
 * admite severidad `minor`/`nit` ni `unverifiable` como resultado: una regla
 * de proyecto que no vale la pena bloquear un PR no debería estar acá, sino
 * en `AcceptanceCriterion` del issue puntual o en ningún lado.
 */
export interface DefinitionOfDoneCriterion {
  /** nanoid estable, no un índice: los findings lo referencian por `dodId`. */
  id: string;
  text: string;
  severity: 'blocker' | 'major';
}

/**
 * Métricas tomadas al cerrar un ciclo (`cycles.close`), congeladas en ese
 * momento — el ciclo ya cerrado no vuelve a recalcularlas aunque sus issues
 * cambien después. `scope`/`completed` son puntos de estimate; `velocity` es
 * lo que E2 promedia sobre los últimos 3 ciclos para sugerir cuánto meter en
 * el próximo. En E1 `velocity` coincidía con `completed`; E5 la separa (el
 * scope agregado a mitad de ciclo cuenta para `scope`/`completed` pero no
 * para `velocity`). `carryover` es el % de los puntos de `scope` que no se
 * completaron y pasaron al ciclo siguiente por el rollover de E5.
 */
export interface CycleSnapshot {
  scope: number;
  completed: number;
  velocity: number;
  carryover: number;
}

/**
 * Scope del ciclo al momento de arrancar (`upcoming` -> `active`), antes de
 * que se le agregue o saque nada — la base contra la que el burndown de E2
 * dibuja la línea ideal y contra la que se mide el scope creep de mitad de
 * ciclo. `estimates` guarda el puntaje de cada issue en ese momento porque el
 * `estimate` del issue puede cambiar después y correrle el piso a la
 * comparación.
 */
export interface CycleInitialScope {
  issueIds: string[];
  estimates: Record<string, number>;
}

export interface Cycle {
  id: string;
  workspaceId: string;
  teamId: string;
  /** Secuencial por equipo, como `Issue.number`. */
  number: number;
  name: string;
  startsAt: string;
  endsAt: string;
  status: CycleStatus;
  /** Solo presente una vez que el ciclo pasó por `active` (lo escribe el
   *  mismo paso que hace la transición, sea manual o el scheduler de E4). */
  initialScope?: CycleInitialScope;
  /** Solo presente una vez que el ciclo pasó por `cycles.close`. */
  snapshot?: CycleSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  workspaceId: string;
  userId: string;
  role: MemberRole;
  displayName: string;
  email: string;
  photoURL?: string;
  joinedAt: string;
  isAgent?: boolean;
  agentKind?: AgentKind;
  /**
   * Denormalizado desde `Agent.role` para que el picker de asignado agrupe
   * Humanos / Dev / QA sin leer `agents`, que es Admin-SDK-only.
   */
  agentRole?: AgentRole;
  /**
   * Tipos de notificación que este miembro apagó para todo el workspace
   * (F4, ver `notifications.updatePreferences`) — vacío/ausente por default
   * (todo prendido). Distinto de silenciar un issue puntual (F1/F3).
   */
  mutedNotificationTypes?: NotificationType[];
}

/**
 * Un repo al que `agents.connectRepo` conectó a este agente (D12/TES-208).
 * `workflowPath`/`secretName` quedan grabados tal como se usaron al conectar
 * (`pulse-agent.yml`/`PULSE_AGENT_MCP_KEY` para `role: 'dev'`,
 * `pulse-qa.yml`/`PULSE_QA_MCP_KEY` para `role: 'qa'`), para que
 * `agents.disconnectRepo` limpie lo mismo que se escribió aunque el `role`
 * del agente haya cambiado después. Hay a lo sumo una entrada por
 * `repoFullName`: reconectar (p. ej. para actualizar la versión del
 * workflow) reemplaza la entrada existente en vez de acumularla.
 */
export interface AgentRepoConnection {
  repoFullName: string;
  apiKeyId: string;
  workflowPath: string;
  workflowSha?: string;
  /** Versión de la plantilla (`WORKFLOW_VERSION`/`QA_WORKFLOW_VERSION`) escrita en el repo. */
  workflowVersion: number;
  secretName: string;
  connectedAt: string;
}

export interface Agent {
  id: string;
  workspaceId: string;
  kind: AgentKind;
  /** Default `'dev'`. Un agente `'qa'` revisa PRs en vez de abrirlos. */
  role: AgentRole;
  displayName: string;
  defaultRepo?: string;
  defaultTeamId?: string;
  /** Repo donde un agente `role: 'qa'` corre el workflow de revisión. */
  reviewRepo?: string;
  maxConcurrentIssues?: number;
  /** Default `2`. Intentos de revisión antes de pasar el issue a `needs_human`. */
  maxReviewAttempts?: number;
  enabled: boolean;
  autonomousMode: boolean;
  createdAt: string;
  /** Repos conectados vía `agents.connectRepo`, con la versión de workflow instalada en cada uno. */
  connectedRepos?: AgentRepoConnection[];
  /** Solo relevante para `role: 'qa'` (D17). Ausente se trata como `'shadow'`. */
  qaMode?: AgentQaMode;
}

/**
 * Proveedor del entorno. Hoy solo Salesforce (épica O), pero el modelo es
 * genérico a propósito: agregar Heroku o un cluster es agregar un sub-objeto
 * como `salesforce` abajo, no una colección nueva.
 */
export type EnvProvider = 'salesforce';

/**
 * Estado de la credencial del entorno. `expired` lo escribe el cliente cuando
 * Salesforce devuelve `invalid_grant` al refrescar: el refresh token murió
 * (revocado, o caducado por política de sesión de la org) y hace falta volver
 * a conectar. No se reintenta solo — reintentar un `invalid_grant` en loop es
 * cómo se llega a un bloqueo de la org.
 */
export type EnvConnectionState = 'connected' | 'expired' | 'revoked' | 'error';

/** Nivel de tests de Apex que corre un deploy. Son los cuatro del CLI de Salesforce. */
export type SalesforceTestLevel =
  | 'NoTestRun'
  | 'RunLocalTests'
  | 'RunAllTestsInOrg'
  | 'RunSpecifiedTests';

/** Contra qué host se autentica la org. Un sandbox usa `test`, una My Domain propia usa `custom`. */
export type SalesforceLoginHost = 'login' | 'test' | 'custom';

/** Datos de la org de Salesforce detrás de un entorno, resueltos al conectar. */
export interface SalesforceOrgInfo {
  /** Id de 18 caracteres de la org. */
  orgId: string;
  /** Host contra el que se hacen las llamadas a la API, p. ej. `https://acme--uat.sandbox.my.salesforce.com`. */
  instanceUrl: string;
  loginHost: SalesforceLoginHost;
  isSandbox: boolean;
  /** Usuario con el que se autorizó. Todo lo que Pulse haga queda auditado en la org como este usuario. */
  username: string;
  /** Versión de la API REST que usa el cliente, p. ej. `'62.0'`. */
  apiVersion: string;
}

/**
 * Un repo al que `environments.connectRepo` le escribió la credencial de este
 * entorno (épica O, O3). Mismo criterio que `AgentRepoConnection`: se guarda
 * lo que efectivamente se escribió, para poder limpiar exactamente eso al
 * desconectar. Una entrada por `repoFullName`.
 */
export interface EnvRepoConnection {
  repoFullName: string;
  /** Nombre del secret del repo, `PULSE_SF_AUTH_<KEY>`. */
  secretName: string;
  workflowPath: string;
  workflowVersion: number;
  /** Key de MCP (`deploy:write`) que el workflow usa para hablar con Pulse. Una por repo. */
  deployKeyId?: string;
  connectedAt: string;
}

/**
 * Un entorno de ejecución del workspace: una org de Salesforce, con la rama
 * de git cuyo HEAD representa lo que está desplegado ahí.
 *
 * Vive en `environments/{envId}`, **Admin SDK only**: el doc guarda el refresh
 * token cifrado en un campo `auth` que esta interfaz deliberadamente no
 * declara, para que no llegue al frontend ni por accidente. El frontend ve
 * esto por la acción `environments.list`, igual que ve la instalación de
 * GitHub por `github.status`.
 */
export interface Environment {
  id: string;
  workspaceId: string;
  /** Clave corta y única por workspace (`dev`, `demo`, `uat`, `prod`). Va en el nombre del secret del repo. */
  key: string;
  displayName: string;
  provider: EnvProvider;
  /** Posición en la cadena de promoción: dev=0, demo=1, uat=2, prod=3. Ordena el pipeline y define qué promueve a qué. */
  position: number;
  /**
   * La rama cuyo HEAD es lo que está desplegado acá. Un push a esta rama
   * despliega. Opcional junto con `repoFullName` (TES-277): leer la org no usa
   * ninguno de los dos; se piden al atar el entorno a un repo.
   */
  trackingBranch?: string;
  repoFullName?: string;
  isProduction: boolean;
  /** Si es true, un deploy a este entorno espera aprobación humana explícita antes de tocar nada. */
  requiresApproval: boolean;
  defaultTestLevel: SalesforceTestLevel;
  /**
   * Habilita escritura directa contra la org (Tooling API, Apex anónimo) sin
   * pasar por git. El backend lo fuerza a `false` cuando `isProduction`, así
   * que no alcanza con no mostrarlo en la UI.
   */
  allowDirectWrites: boolean;
  connectionState: EnvConnectionState;
  lastVerifiedAt?: string;
  /** Último sha desplegado con éxito. Es la base desde la que se calcula el delta del próximo deploy. */
  deployedSha?: string;
  deployedAt?: string;
  salesforce?: SalesforceOrgInfo;
  connectedRepos?: EnvRepoConnection[];
  createdAt: string;
  /** Uid de quien autorizó la conexión. */
  connectedBy: string;
}

export type DeploymentMode = 'validate' | 'deploy' | 'quick';

/**
 * `awaiting_approval`: el entorno tiene `requiresApproval` y el deploy no tocó
 * la org. La aprobación en sí es O8 (TES-258); mientras tanto, un deploy a un
 * entorno con aprobación queda frenado acá en vez de pasar sin puerta.
 */
export type DeploymentStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'awaiting_approval';

export type DeploymentTrigger = 'promotion' | 'push' | 'manual' | 'pr_validation';

/** Un error de un deploy, tomado del `--json` del CLI de Salesforce. */
export interface DeploymentError {
  kind: 'component' | 'test' | 'general';
  /** `ApexClass`, `CustomField`… (componentes) o la clase de test. */
  componentType?: string;
  /** Nombre del componente, o `Clase.metodo` para un test. */
  fullName?: string;
  problem: string;
  lineNumber?: number;
  columnNumber?: number;
}

/**
 * Un deploy (o validación) contra la org de un entorno (O3/TES-253). Vive en
 * `deployments/{id}`: lectura por membresía, escritura sólo Admin SDK. Lo crea
 * el workflow del repo con `pulse_start_deployment` y lo cierra con
 * `pulse_report_deployment`.
 */
export interface Deployment {
  id: string;
  workspaceId: string;
  projectId?: string;
  environmentId: string;
  envKey: string;
  repoFullName: string;
  branch: string;
  sha: string;
  /**
   * PR validado (`trigger: 'pr_validation'`, O5/TES-255). Un push nuevo al PR
   * revalida sobre este mismo `Deployment` en vez de abrir otro, así el issue
   * tiene una sola validación vigente por PR.
   */
  prNumber?: number;
  /** Base del delta: el `deployedSha` del entorno al arrancar. Ausente = deploy completo. */
  fromSha?: string;
  mode: DeploymentMode;
  status: DeploymentStatus;
  issueIds: string[];
  trigger: DeploymentTrigger;
  requestedBy: string;
  approvedBy?: string;
  approvedAt?: string;
  runUrl?: string;
  salesforce?: {
    deployRequestId?: string;
    componentsTotal?: number;
    componentsFailed?: number;
    testsRun?: number;
    testsFailed?: number;
    coveragePercent?: number;
  };
  errors?: DeploymentError[];
  startedAt: string;
  endedAt?: string;
  /** `YYYY-MM-DD` (UTC) de `startedAt`, como `AgentRun.date`: agregar por día sin rango. */
  date: string;
}

/** Campos de un `Environment` que `environments.update` acepta modificar. */
export const ENVIRONMENT_WRITABLE_FIELDS = [
  'displayName',
  'position',
  'trackingBranch',
  'requiresApproval',
  'defaultTestLevel',
  'allowDirectWrites',
] as const;

export type EnvironmentWritableField = (typeof ENVIRONMENT_WRITABLE_FIELDS)[number];

/**
 * Un cierre humano (merge o close sin merge) del PR de un issue con veredicto
 * de QA, contrastado contra ese veredicto (D17/TES-213). Vive en
 * `qa_calibration_records/{issueId}_{attempt}`, Admin SDK only — el id
 * determinístico hace que reintentos del webhook o varios PRs (`gitRefs[]`)
 * cerrando el mismo intento pisen el registro en vez de duplicarlo.
 *
 * Solo se escribe cuando el veredicto era `approved` o `changes_requested`
 * (`needs_human`/`stale`/`running` no dan una señal clara de acuerdo). El
 * agrupador de la tasa de acuerdo (`agents.getQaCalibration`) lee las últimas
 * N de estos por `agentId`.
 */
export interface QaCalibrationRecord {
  id: string;
  workspaceId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  verdict: 'approved' | 'changes_requested';
  humanOutcome: 'merged' | 'closed_unmerged';
  agreed: boolean;
  repoFullName: string;
  prNumber: number;
  decidedAt: string;
}

export interface IssueAgentState {
  claimedBy?: string;
  claimedAt?: string;
  state?: AgentIssueState;
  blockedReason?: string;
}

/**
 * Un dispatch de agente (D15). Colección `agent_runs/{runId}`, Admin-SDK-only
 * (igual que `agent_dispatch_counters`): el trigger de dispatch crea el
 * registro con `outcome` ausente, y el paso de reporte del workflow lo
 * completa con lo que trae el mensaje `result` del execution file
 * (`total_cost_usd`, `num_turns`) al terminar — incluidos los runs que
 * fallan o agotan el tiempo, para que el costo de un issue no quede
 * subestimado.
 */
export interface AgentRun {
  id: string;
  issueId: string;
  workspaceId: string;
  agentId: string;
  role: AgentRole;
  mode: AgentRunMode;
  repo: string;
  runUrl?: string;
  startedAt: string;
  endedAt?: string;
  turns?: number;
  costUsd?: number;
  outcome?: AgentRunOutcome;
  /** Solo para `role: 'qa'` — a qué intento de `IssueReview` corresponde este run. */
  reviewAttempt?: number;
  /**
   * Fecha (`YYYY-MM-DD`, UTC) de `startedAt`, denormalizada. Permite sumar
   * `costUsd`/contar runs del día con un `where('date','==',x)` en vez de un
   * rango sobre `startedAt`, igual que `agent_dispatch_counters` (D8).
   */
  date: string;
}

/**
 * Costo acumulado de un issue (D15), denormalizado en `Issue.agentStats` para
 * no tener que sumar sus `agent_runs` en cada lectura.
 */
export interface IssueAgentStats {
  runs: number;
  costUsd: number;
  lastRunAt: string;
}

export interface IssueGitState {
  /**
   * El repo al que pertenece el issue. En una épica hace de default para todos
   * sus hijos; en un issue, de override. Se resuelve en cascada
   * issue -> épica -> agente (ver `resolveIssueRepo` en el backend).
   */
  repoFullName?: string;
  branch?: string;
  branchUrl?: string;
  baseBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: 'open' | 'draft' | 'merged' | 'closed';
  lastSyncedAt?: string;
  /**
   * Último estado que puso el sync de GitHub. Si `status` difiere de esto,
   * un humano lo movió a mano y el webhook no debe pisarlo.
   */
  lastSyncedStatus?: IssueStatus;
}

/**
 * Una rama (y su PR, si existe) de un issue en un repo concreto.
 *
 * Existe porque un issue puede tocar más de un repo: el modelo de dominio vive
 * en pulse-app y sus consumidores en pulse-backend, así que un cambio de tipos
 * necesita una rama en cada uno. `Issue.git`, que es un objeto único, no puede
 * representar eso — la segunda rama pisaba a la primera.
 */
export interface IssueGitRef {
  repoFullName: string;
  branch?: string;
  branchUrl?: string;
  baseBranch?: string;
  prNumber?: number;
  prUrl?: string;
  prState?: 'open' | 'draft' | 'merged' | 'closed';
  lastSyncedAt?: string;
  /** SHA de `pull_request.head` en el último evento de webhook procesado. */
  headSha?: string;
  /** Cuándo se registró `headSha` por última vez. */
  headShaAt?: string;
}

/**
 * Trabajo pendiente en OTRO repo, registrado por el run que lo detectó para que
 * otro run lo retome (TES-202). Cada run solo tiene credenciales sobre su repo,
 * así que en vez de empujar a un segundo repo deja este traspaso en el issue: el
 * backend lo despacha al repo destino y la entrada se cierra sola cuando ese
 * repo abre su PR.
 *
 * Es un campo y no un comentario a propósito: un run nuevo lo lee sin depender
 * de que el modelo interprete texto libre. El comentario que se publica junto
 * es solo para las personas.
 */
export interface PendingRepoWork {
  /** Repo donde falta trabajo. Una entrada por repo. */
  repoFullName: string;
  /** Qué falta hacer allá. */
  summary: string;
  /** Qué ya está hecho en el repo de origen (contexto para quien lo retome). */
  done?: string;
  sourceRepoFullName?: string;
  sourceBranch?: string;
  sourcePrNumber?: number;
  requestedBy: string;
  requestedAt: string;
  /** Lo marca `agentDispatchTrigger` al despachar el run del repo destino. */
  dispatchedAt?: string;
}

/**
 * Por qué un run no pudo terminar algo que el issue pedía (TES-219). No es
 * texto libre a propósito: el motivo decide quién tiene que retomarlo — una
 * decisión de producto va a una persona, una operación de producción a quien
 * tenga las credenciales, y nada de eso lo puede resolver otro run.
 */
export type PendingWorkReason =
  | 'needs_prod_credentials'
  | 'product_decision'
  | 'out_of_scope'
  | 'blocked'
  /** Solo lo pone QA: el criterio no se puede verificar desde un run, hay que hacerlo a mano. */
  | 'needs_manual_verification';

/**
 * Trabajo que quedó sin hacer y que **ningún run puede retomar** (TES-219).
 *
 * Es el caso hermano de `PendingRepoWork`, y existe por el mismo motivo: antes
 * de esto un agente que no podía terminar algo lo escribía en el cuerpo del PR,
 * el merge cerraba el issue y el aviso se perdía (ver TES-218, cuya migración de
 * keys quedó sin correr exactamente así). La diferencia con `PendingRepoWork` es
 * el desenlace: aquello se despacha a otro repo, esto **crea un issue de
 * seguimiento** que hereda el pendiente, porque no hay run que lo pueda tomar.
 *
 * `followUpIssueId` lo completa el servidor al crear ese hijo. Una entrada sin
 * él es un pendiente declarado que no llegó a materializarse en un issue: eso
 * es lo que bloquea el cierre del padre.
 */
export interface PendingWork {
  /** nanoid estable: el gate de cierre y el follow-up lo referencian. */
  id: string;
  /** Qué falta hacer, en una línea — es el título del issue de seguimiento. */
  summary: string;
  reason: PendingWorkReason;
  /** Contexto para quien lo retome: qué se intentó, qué quedó escrito, qué falta. */
  context?: string;
  /** `AcceptanceCriterion.id` del issue que queda sin cumplir, si aplica. */
  criterionId?: string;
  /** Issue de seguimiento creado por el servidor. Ausente: no se pudo crear. */
  followUpIssueId?: string;
  /** ej. "TES-220" — denormalizado para no tener que leer el hijo al mostrarlo. */
  followUpIdentifier?: string;
  /** `'dev'`: lo declaró el agente que hizo el trabajo. `'qa'`: lo dedujo la revisión de un criterio `unverifiable`. */
  source: 'dev' | 'qa';
  reportedBy: string;
  reportedAt: string;
}

/**
 * Marca en el issue de seguimiento de dónde salió (TES-219). El vínculo fuerte
 * es `parentId` (el follow-up cuelga del issue original); esto guarda lo que la
 * jerarquía sola no dice: qué criterio quedó colgando y por qué motivo.
 */
export interface FollowUpOrigin {
  issueId: string;
  identifier: string;
  reason: PendingWorkReason;
  criterionId?: string;
}

export interface Issue {
  id: string;
  workspaceId: string;
  teamId: string;
  projectId?: string;
  /** ej. "ENG-142" */
  identifier: string;
  number: number;
  title: string;
  description?: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** Default `'task'`. Los issues creados antes de la jerarquía se migran a `'task'`. */
  type: IssueType;
  assigneeId?: string;
  creatorId: string;
  labelIds: string[];
  /** Padre directo: la épica de una historia, o la historia de una sub-tarea. */
  parentId?: string;
  /**
   * Épica raíz del subárbol, denormalizada. Permite `where('epicId','==',x)` en
   * Firestore y filtrado O(1) en el store sin recorrer el árbol hacia arriba.
   * Una épica NO se referencia a sí misma acá: para `type: 'epic'` es undefined.
   */
  epicId?: string;
  /** Contadores denormalizados: evitan leer N hijos para pintar una barra de progreso. */
  subIssueCount?: number;
  subIssueDoneCount?: number;
  dueDate?: string;
  /**
   * Fecha de inicio, sobre todo para épicas: junto con `dueDate` define el
   * rango que la vista Timeline (E6) dibuja como barra. Opcional y ajeno al
   * status — una épica puede tener fechas planeadas sin haber arrancado.
   */
  startDate?: string;
  estimate?: number;
  /** Ciclo al que pertenece. Ausente significa backlog/sin planear. */
  cycleId?: string;
  /**
   * Solo significativo en épicas: preselecciona el asignado al crear un issue
   * hijo. Es preselección al crear, no herencia en runtime — si el dispatch
   * heredara el agente de la épica, un issue que dejaste sin asignar a
   * propósito podría despertar a un agente solo, y "sin asignar" dejaría de
   * significar algo.
   */
  defaultAssigneeId?: string;
  agent?: IssueAgentState;
  /**
   * La rama "principal": la del repo donde corre el job del agente. Se mantiene
   * por compatibilidad con los issues anteriores a `gitRefs` y porque el ruteo
   * del dispatch la sigue usando.
   */
  git?: IssueGitState;
  /**
   * Todas las ramas del issue, una por repo. `git` es la primera de estas; el
   * resto se suma cuando el trabajo abarca varios repos.
   */
  gitRefs?: IssueGitRef[];
  /** Traspasos a otros repos todavía sin PR. Mientras haya alguno el issue no pasa a `in_review`. */
  pendingRepoWork?: PendingRepoWork[];
  /**
   * Trabajo declarado pendiente que ningún run puede retomar (TES-219). No
   * bloquea el cierre por sí mismo: lo que lo bloquea es una entrada sin
   * `followUpIssueId`, o un criterio `not_met` sin entrada que lo cubra.
   */
  pendingWork?: PendingWork[];
  /** Solo en un issue creado como seguimiento de otro (TES-219). */
  followUpOf?: FollowUpOrigin;
  /** Rúbrica del issue (D1). Ausente o vacío: sin criterios, el QA (D6) no tiene contra qué verificar. */
  acceptanceCriteria?: AcceptanceCriterion[];
  /**
   * Intento de revisión de QA en curso (D3). Ausente: el issue nunca entró al
   * loop de revisión. El *resultado* de QA vive acá, no en `status` — no hay
   * `qa_failed` en `IssueStatus` (ver decisión en TES-148): agregar estados
   * nuevos por algo ortogonal al status rompería el board, los filtros,
   * `ISSUE_STATUSES`, `StatusBadge` y el mapeo del webhook.
   */
  review?: IssueReview;
  /**
   * Autoverificación del dev contra la rúbrica antes de abrir el PR (D13).
   * El QA la recibe en `pulse_get_review_context` para contrastarla, no para
   * creerla ciegamente.
   */
  devSelfCheck?: DevCriterionCheck[];
  /** Runs y costo acumulados del issue (D15), denormalizado desde `agent_runs`. Ausente: todavía no corrió ningún agente. */
  agentStats?: IssueAgentStats;
  createdAt: string;
  updatedAt: string;
}

/**
 * Un criterio de la rúbrica contra la que el QA (D6) verifica un issue. Sin
 * criterios aceptados el QA solo puede opinar, que es justo lo que D1 quiere
 * evitar.
 */
export interface AcceptanceCriterion {
  /** nanoid estable, no un índice: los findings y la autoverificación (D13) lo referencian. */
  id: string;
  text: string;
  /** Ausente equivale a `'manual'`: lo escribió una persona o un agente en la UI o por MCP. */
  source?: 'manual' | 'generated';
  /**
   * Solo significativo para `source: 'generated'`: `issues.generateCriteria`
   * los crea en `false`, y el QA no los usa hasta que un humano los pase a
   * `true`. Ausente en criterios manuales, que se consideran aceptados.
   */
  accepted?: boolean;
}

/**
 * Resultado de una revisión de QA (D3). `pending`/`running` son el intento en
 * curso; `approved`/`changes_requested`/`needs_human` son los tres cierres
 * posibles (D6). `needs_human` cubre tanto los intentos agotados como el caso
 * en que el único problema es un criterio `unverifiable` ("la animación se
 * siente fluida") — eso no es un rechazo, así que no puede ser
 * `changes_requested`.
 *
 * `stale`: la aprobación quedó desactualizada porque hubo código nuevo después
 * de aprobar (push posterior al `headSha` revisado, D10) o porque cambiaron
 * los criterios contra los que se aprobó (edición de `acceptanceCriteria`,
 * D1). Un issue en `stale` con intentos disponibles se vuelve a revisar en
 * vez de quedar aprobado sobre código o criterios que ya no son los mismos.
 */
export type ReviewState =
  | 'pending'
  | 'running'
  | 'approved'
  | 'changes_requested'
  | 'needs_human'
  | 'stale';

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

/**
 * `open`: sin resolver todavía. `fixed`: el re-trabajo del dev (D9) lo marca
 * así al pushear una corrección. `disputed`: el dev no está de acuerdo y pide
 * que el QA lo reconsidere en la re-revisión. `dismissed`: un humano lo
 * descarta a mano desde la UI (D7, "Descartar finding") sin que medie un push.
 */
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'dismissed';

/**
 * Resultado de verificar un criterio puntual de la rúbrica contra el código
 * revisado. `criterionId` referencia un `AcceptanceCriterion.id` del issue, o
 * (D14/TES-210) un `DefinitionOfDoneCriterion.id` del proyecto — en ambos
 * casos es solo un id, no hace falta distinguir la procedencia acá.
 * `unverifiable` es su propio resultado, no un `fail`: un
 * criterio que no se puede confirmar automáticamente no debería tumbar el PR
 * por las mismas razones que uno que sí falla.
 */
export interface ReviewCriterionResult {
  criterionId: string;
  result: 'pass' | 'fail' | 'unverifiable';
  /** Nota del QA sobre por qué llegó a ese resultado — texto libre, para revisión humana. */
  evidence?: string;
}

/**
 * Observación puntual de la revisión. `id` es estable (no un índice) porque
 * el re-trabajo de D9 y el "Descartar finding" de D7 lo referencian para
 * actualizar `status` sin depender de la posición en el array.
 * `repoFullName` distingue a qué PR pertenece cuando el issue tiene más de
 * uno (K9/TES-202) — ausente en el caso de un solo repo.
 */
export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  status: FindingStatus;
  criterionId?: string;
  /** Referencia a un `DefinitionOfDoneCriterion.id` del proyecto (D14), en vez de `criterionId`, cuando el finding viola una regla de proyecto y no un criterio del issue. */
  dodId?: string;
  repoFullName?: string;
  file?: string;
  line?: number;
  message: string;
  /** Motivo que da el dev al resolver el finding (D9, `pulse_resolve_finding`): por qué lo considera `fixed` o `disputed`. */
  resolutionNote?: string;
}

/**
 * Resultado de la autoverificación del dev (D13) para un criterio puntual,
 * antes de abrir el PR. `criterionId` referencia un `AcceptanceCriterion.id`
 * del issue. El QA la recibe en `pulse_get_review_context` como dato a
 * contrastar contra el diff, no como una verdad ya confirmada.
 */
export interface DevCriterionCheck {
  criterionId: string;
  result: 'met' | 'not_met' | 'unverifiable';
  /** Evidencia puntual: archivo, comando corrido, o salida — texto libre. */
  evidence: string;
}

/** PR revisado en un repo puntual, con el SHA exacto que vio el QA (D10, K9/TES-202). */
export interface ReviewPrRef {
  repoFullName: string;
  prNumber: number;
  headSha: string;
}

/**
 * Un intento de revisión cerrado. Mismos campos que `IssueReview` salvo
 * `history`, que no anida — cada entrada de `IssueReview.history` es uno de
 * estos, no un árbol.
 */
export interface IssueReviewAttempt {
  state: ReviewState;
  /** Agente `role: 'qa'` que corrió (o está corriendo) este intento. */
  reviewerId?: string;
  /** 1-based. Tope en `Agent.maxReviewAttempts`; agotado sin aprobación, el cierre es `needs_human`. */
  attempt: number;
  /** Resumen en lenguaje natural del veredicto, para humanos — los datos estructurados van en `findings`/`criteriaResults`. */
  verdict?: string;
  /** Un elemento por repo con PR abierto (K9/TES-202). Ausente en el caso de un solo repo sin registrar todavía. */
  prs?: ReviewPrRef[];
  findings?: ReviewFinding[];
  criteriaResults?: ReviewCriterionResult[];
  startedAt?: string;
  completedAt?: string;
  /**
   * Presente cuando un humano forzó el veredicto con `reviews.override` (D5)
   * — "Aprobar igual" en D7. Es un callable autenticado, no una tool MCP: solo
   * una persona puede pisar el veredicto del QA, y queda en el historial con
   * su uid para que quede claro que no lo decidió el agente.
   */
  overriddenBy?: string;
  overriddenAt?: string;
  overrideReason?: string;
}

/**
 * Intento de revisión de QA en curso sobre un issue (D3). Se guarda embebido
 * en el issue en vez de en una subcolección: el volumen es acotado (tope de
 * `Agent.maxReviewAttempts`) y así viaja entero en `pulse_get_issue` sin una
 * lectura aparte.
 */
export interface IssueReview extends IssueReviewAttempt {
  /**
   * Lock de la revisión, separado de `IssueAgentState` a propósito: mientras
   * el QA revisa, el dev sigue con el issue reclamado (`agent.state`) — son
   * dos actores distintos trabajando el mismo issue a la vez, no un traspaso
   * de posesión.
   */
  claimedBy?: string;
  claimedAt?: string;
  /**
   * Quién despachó `qaDispatchTrigger` (D4) para este intento y cuándo — el
   * agente QA que `reviews.start` (D5) debe reclamar, y la base del guard
   * anti-ping-pong (comparar contra el head SHA actual de cada PR).
   */
  dispatchedTo?: string;
  dispatchedAt?: string;
  /**
   * Intentos ya cerrados, más viejo primero. Sin esto no hay métricas de D7
   * (intentos promedio, tasa de aprobación al primer intento) — solo
   * quedaría el último intento y se perdería el resto.
   */
  history?: IssueReviewAttempt[];
  /**
   * Asignado justo antes de que `reviews.submit` (D5) reasignara el issue al
   * lead por `needs_human`. Sin esto, "Devolver al agente" (D7) no sabría a
   * quién devolvérselo sin buscarlo a mano en el historial.
   */
  previousAssigneeId?: string;
  /**
   * Cuándo se despachó el run de re-trabajo (D9) y para qué `attempt` fue —
   * la guarda contra doble despacho compara `reworkDispatchedForAttempt`
   * contra `attempt` en vez de un cooldown de tiempo, porque lo que puede
   * repetirse es el mismo intento, no el paso del reloj.
   */
  reworkDispatchedAt?: string;
  reworkDispatchedForAttempt?: number;
}

export interface Comment {
  id: string;
  workspaceId: string;
  issueId: string;
  authorId: string;
  body: string;
  source: 'web' | 'mcp' | 'github';
  githubCommentId?: string;
  createdAt: string;
}

export interface Activity {
  id: string;
  issueId: string;
  actorId: string;
  type:
    | 'status_change'
    | 'assignment'
    | 'label'
    | 'comment'
    | 'created'
    | 'priority_change'
    | 'parent_change';
  changes?: {
    fromValue?: string;
    toValue?: string;
  };
  createdAt: string;
}

/**
 * `due_soon` queda en el enum desde F1 pero su generación es de F5
 * (recordatorios de vencimiento) — todavía no hay nada que la emita.
 */
export type NotificationType =
  | 'assigned'
  | 'mentioned'
  | 'comment'
  | 'status_change'
  | 'review_result'
  | 'due_soon';

/** Presets rápidos de snooze (F4, ver `notifications.snooze`). `'clear'` saca el snooze. */
export type SnoozePreset = '1h' | 'tomorrow' | 'next_week' | 'clear';

/**
 * Generada server-side (Admin SDK) por triggers sobre `issues` y por
 * `comments.create` — nunca escrita por el cliente. `readAt` es la marca de
 * cuándo se leyó; `read` es la que filtra el inbox y el badge de contador.
 */
export interface Notification {
  id: string;
  workspaceId: string;
  userId: string;
  type: NotificationType;
  issueId: string;
  actorId: string;
  title: string;
  body: string;
  read: boolean;
  readAt?: string;
  createdAt: string;
  /**
   * Snooze de esta notificación puntual (F4, ver `notifications.snooze`).
   * Mientras sea futuro, se oculta del inbox — filtrado client-side en
   * `subscribeUserNotifications`/`subscribeAllUserNotifications`, sin cron.
   */
  snoozedUntil?: string;
}

// ---------------------------------------------------------------------------
// Catálogos de presentación
// ---------------------------------------------------------------------------

export interface IssueStatusOption {
  value: IssueStatus;
  label: string;
  order: number;
}

export const ISSUE_STATUSES: IssueStatusOption[] = [
  { value: 'backlog', label: 'Backlog', order: 0 },
  { value: 'todo', label: 'Por hacer', order: 1 },
  { value: 'in_progress', label: 'En progreso', order: 2 },
  { value: 'in_review', label: 'En revisión', order: 3 },
  { value: 'done', label: 'Completado', order: 4 },
  { value: 'canceled', label: 'Cancelado', order: 5 },
];

export interface IssuePriorityOption {
  value: IssuePriority;
  label: string;
}

/** Orden intencional: urgente → baja, "sin prioridad" al final. */
export const ISSUE_PRIORITIES: IssuePriorityOption[] = [
  { value: 1, label: 'Urgente' },
  { value: 2, label: 'Alta' },
  { value: 3, label: 'Media' },
  { value: 4, label: 'Baja' },
  { value: 0, label: 'Sin prioridad' },
];

export interface IssueTypeOption {
  value: IssueType;
  label: string;
  /** Nivel jerárquico: 0 épica, 1 historia/tarea/bug, 2 sub-tarea. */
  depth: 0 | 1 | 2;
}

export const ISSUE_TYPES: IssueTypeOption[] = [
  { value: 'epic', label: 'Épica', depth: 0 },
  { value: 'story', label: 'Historia', depth: 1 },
  { value: 'task', label: 'Tarea', depth: 1 },
  { value: 'bug', label: 'Bug', depth: 1 },
  { value: 'subtask', label: 'Sub-tarea', depth: 2 },
];

export const DEFAULT_ISSUE_TYPE: IssueType = 'task';

export function getStatusLabel(status: IssueStatus | string): string {
  return ISSUE_STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function getPriorityLabel(priority: IssuePriority | number): string {
  return ISSUE_PRIORITIES.find((p) => p.value === priority)?.label ?? 'Sin prioridad';
}

export function getIssueTypeLabel(type: IssueType | string): string {
  return ISSUE_TYPES.find((t) => t.value === type)?.label ?? type;
}

/**
 * Estados que cuentan como "cerrado" para el progreso de un padre.
 *
 * `canceled` cuenta: una sub-tarea cancelada no debería impedir que su historia
 * muestre 8/8. Lo que importa para el progreso es que no queda trabajo pendiente,
 * no que el trabajo se haya hecho.
 */
export const COMPLETED_ISSUE_STATUSES: readonly IssueStatus[] = ['done', 'canceled'];

export function isCompletedStatus(status: IssueStatus | string): boolean {
  return (COMPLETED_ISSUE_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Reglas de jerarquía
// ---------------------------------------------------------------------------

/**
 * Qué tipo puede colgar de qué tipo. Es la definición completa de la jerarquía
 * — la profundidad máxima (3 niveles) y las prohibiciones ("una épica no tiene
 * padre", "una sub-tarea no tiene hijos") caen de acá, no se chequean aparte.
 *
 * El backend valida contra esta tabla en `issues.create`/`issues.update`; el
 * frontend la usa para no ofrecer combinaciones inválidas en los selectores.
 */
export const ALLOWED_PARENT_TYPES: Record<IssueType, readonly IssueType[]> = {
  epic: [],
  story: ['epic'],
  task: ['epic'],
  bug: ['epic'],
  subtask: ['story', 'task', 'bug'],
};

export const MAX_HIERARCHY_DEPTH = 3;

/** ¿Puede un issue de tipo `childType` colgar de uno de tipo `parentType`? */
export function canHaveParent(childType: IssueType, parentType: IssueType): boolean {
  return ALLOWED_PARENT_TYPES[childType].includes(parentType);
}

/** ¿Puede un issue de este tipo tener padre? Falso solo para las épicas. */
export function canBeChild(childType: IssueType): boolean {
  return ALLOWED_PARENT_TYPES[childType].length > 0;
}

/** ¿Puede un issue de este tipo tener hijos? Falso solo para las sub-tareas. */
export function canHaveChildren(parentType: IssueType): boolean {
  return (Object.keys(ALLOWED_PARENT_TYPES) as IssueType[]).some((child) =>
    ALLOWED_PARENT_TYPES[child].includes(parentType)
  );
}

/**
 * `epicId` que le corresponde a un hijo, dado su padre. Una épica es su propia
 * raíz para sus hijos; para niveles más profundos se hereda el `epicId` del
 * padre. Devuelve `undefined` cuando el subárbol no cuelga de ninguna épica.
 */
export function resolveEpicId(parent: Pick<Issue, 'id' | 'type' | 'epicId'>): string | undefined {
  return parent.type === 'epic' ? parent.id : parent.epicId;
}

// ---------------------------------------------------------------------------
// Campos escribibles por un caller
// ---------------------------------------------------------------------------

/**
 * Campos que un caller (cliente, tool MCP, o request de Platform Action) puede
 * setear en un issue. Whitelist deliberada, no un spread: la data puede venir
 * de un tool MCP manejado por un LLM, y un spread dejaría escribir campos que
 * son del servidor.
 *
 * Excluidos a propósito por ser siempre asignados por el servidor: `id`,
 * `identifier`, `number`, `workspaceId`, `teamId`, `creatorId`, `createdAt`,
 * `updatedAt`, `epicId` (se deriva de `parentId`) y los contadores
 * `subIssueCount`/`subIssueDoneCount` (se mantienen en transacción).
 */
export const ISSUE_WRITABLE_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'type',
  'projectId',
  'assigneeId',
  'labelIds',
  'parentId',
  'dueDate',
  'startDate',
  'estimate',
  'defaultAssigneeId',
  'cycleId',
  'acceptanceCriteria',
] as const;

export type IssueWritableField = (typeof ISSUE_WRITABLE_FIELDS)[number];

export const PROJECT_WRITABLE_FIELDS = [
  'name',
  'description',
  'status',
  'kind',
  'repoFullNames',
  'leadId',
  'color',
  'targetDate',
  'definitionOfDone',
] as const;

export type ProjectWritableField = (typeof PROJECT_WRITABLE_FIELDS)[number];

/**
 * `status` está incluido porque `cycles.update` lo sigue permitiendo como
 * pasaje manual `upcoming` -> `active`, en paralelo al scheduler automático
 * de E4 (`cycles.updateSettings` + el trigger programado). La transición a
 * `completed` no pasa por acá: `cycles.update` la rechaza explícitamente
 * porque `completed` solo puede salir de `cycles.close`, que además hace el
 * rollover y el snapshot — dejarla pasar por un update común dejaría un
 * ciclo "cerrado" sin ninguna de las dos cosas.
 */
export const CYCLE_WRITABLE_FIELDS = ['name', 'startsAt', 'endsAt', 'status'] as const;

export type CycleWritableField = (typeof CYCLE_WRITABLE_FIELDS)[number];

/** Campos que `cycles.updateSettings` puede tocar de `Team.cycleSettings`. */
export const CYCLE_SETTINGS_WRITABLE_FIELDS = [
  'enabled',
  'lengthWeeks',
  'startDayOfWeek',
  'autoCreate',
] as const;

export type CycleSettingsWritableField = (typeof CYCLE_SETTINGS_WRITABLE_FIELDS)[number];
