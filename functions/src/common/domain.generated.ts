// ============================================================
// GENERADO — NO EDITAR A MANO.
//
// Copia de `pulse-app/src/types/domain.ts`, la fuente única del modelo de
// dominio de Pulse. Para cambiar algo de acá, editá ese archivo y corré
// `npm run sync:types` desde `pulse-app`.
//
// SOURCE_HASH: eda00aa3cd25f3ec
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

export type AgentKind = 'claude' | 'chatgpt';

export type AgentIssueState = 'idle' | 'claimed' | 'working' | 'pr_open' | 'blocked';

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
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
}

export interface Label {
  id: string;
  teamId: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  teamId: string;
  name: string;
  description: string;
  status: ProjectStatus;
  leadId?: string;
  color?: string;
  targetDate?: string;
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
}

export interface Agent {
  id: string;
  workspaceId: string;
  kind: AgentKind;
  displayName: string;
  defaultRepo?: string;
  defaultTeamId?: string;
  maxConcurrentIssues?: number;
  enabled: boolean;
  autonomousMode: boolean;
  createdAt: string;
}

export interface IssueAgentState {
  claimedBy?: string;
  claimedAt?: string;
  state?: AgentIssueState;
  blockedReason?: string;
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
  estimate?: number;
  /**
   * Solo significativo en épicas: preselecciona el asignado al crear un issue
   * hijo. Es preselección al crear, no herencia en runtime — si el dispatch
   * heredara el agente de la épica, un issue que dejaste sin asignar a
   * propósito podría despertar a un agente solo, y "sin asignar" dejaría de
   * significar algo.
   */
  defaultAssigneeId?: string;
  agent?: IssueAgentState;
  git?: IssueGitState;
  createdAt: string;
  updatedAt: string;
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
  'estimate',
  'defaultAssigneeId',
] as const;

export type IssueWritableField = (typeof ISSUE_WRITABLE_FIELDS)[number];

export const PROJECT_WRITABLE_FIELDS = [
  'name',
  'description',
  'status',
  'leadId',
  'color',
  'targetDate',
] as const;

export type ProjectWritableField = (typeof PROJECT_WRITABLE_FIELDS)[number];
