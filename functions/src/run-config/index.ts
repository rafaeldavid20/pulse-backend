import { RUN_CONFIG_VERSION, REVIEW_PROMPT, REWORK_PROMPT, TASK_PROMPT, handoffBlock, renderTemplate } from './prompts';

export { RUN_CONFIG_VERSION };

/**
 * Configuración con la que arranca un run (TES-228 / M1).
 *
 * El `.yml` que `agents.connectRepo` escribe en el repo del cliente ya no lleva
 * el prompt ni las listas de tools: las pide acá al arrancar. La diferencia
 * práctica es que cambiar cualquiera de esas cosas deja de exigir un commit en
 * el repo de cada cliente más una reconexión — el próximo run ya las usa.
 */

export type RunMode = 'task' | 'rework' | 'review';

export interface RunConfigContext {
  issueId: string;
  issueIdentifier: string;
  /** Solo en `task`: repo destino cuando el run continúa un traspaso (TES-202). */
  handoffRepo?: string;
  /** Solo en `rework`/`review`: número de intento de revisión. */
  reviewAttempt?: number;
}

export interface RunConfig {
  version: number;
  mode: RunMode;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** Tope de turnos, cuando el modo lo define. `undefined` deja el default de la acción. */
  maxTurns?: number;
  /**
   * Skills que el run tiene que materializar antes de invocar a Claude. Vacío
   * hasta M3/M4 (TES-230/TES-231): acá se construye el canal, no el contenido.
   */
  skills: RunSkill[];
}

export interface RunSkill {
  /** Nombre del directorio: `.claude/skills/<name>/SKILL.md`. */
  name: string;
  /** Contenido completo del `SKILL.md`, con su frontmatter. */
  content: string;
  /** De dónde salió: sirve para que el run pueda decir con qué corrió. */
  source: 'workspace' | 'project';
}

/**
 * `Skill` está habilitada desde M1: sin eso, un skill disponible en el checkout
 * no se puede invocar igual (TES-230 depende de esto).
 *
 * `Agent`/`Task` siguen prohibidas a propósito y no son configurables. En un run
 * headless terminar el turno termina la sesión: TES-132 se perdió porque el
 * agente lanzó subagentes y cerró su turno para esperarlos. Un skill que
 * despacha subagentes no va a funcionar acá, y es mejor que falle explícito a
 * que un cliente lo descubra con un run a medias.
 */
const FORBIDDEN_TOOLS = ['Agent', 'Task', 'ScheduleWakeup', 'Monitor', 'CronCreate'];

const DEV_TOOLS = ['mcp__pulse', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Skill'];

/**
 * QA no edita: su output es un veredicto, no un cambio de código. Las de
 * escritura se prohíben explícitamente además de no estar permitidas — es una
 * regla del protocolo, no una preferencia, y conviene que se lea como tal.
 */
const QA_TOOLS = ['mcp__pulse', 'Bash', 'Read', 'Glob', 'Grep', 'Skill'];
const QA_FORBIDDEN_TOOLS = [...FORBIDDEN_TOOLS, 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

const QA_MAX_TURNS = 40;

export function buildRunConfig(mode: RunMode, context: RunConfigContext, skills: RunSkill[] = []): RunConfig {
  const vars: Record<string, string | number | undefined> = {
    issueId: context.issueId,
    issueIdentifier: context.issueIdentifier,
    reviewAttempt: context.reviewAttempt,
    handoffBlock: handoffBlock(context.handoffRepo),
  };

  if (mode === 'review') {
    return {
      version: RUN_CONFIG_VERSION,
      mode,
      prompt: renderTemplate(REVIEW_PROMPT, vars),
      allowedTools: QA_TOOLS,
      disallowedTools: QA_FORBIDDEN_TOOLS,
      maxTurns: QA_MAX_TURNS,
      skills,
    };
  }

  return {
    version: RUN_CONFIG_VERSION,
    mode,
    prompt: renderTemplate(mode === 'rework' ? REWORK_PROMPT : TASK_PROMPT, vars),
    allowedTools: DEV_TOOLS,
    disallowedTools: FORBIDDEN_TOOLS,
    skills,
  };
}

export function isRunMode(value: unknown): value is RunMode {
  return value === 'task' || value === 'rework' || value === 'review';
}
