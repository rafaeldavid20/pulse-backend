/**
 * Scopes granulares del MCP (D11/TES-207). Antes de esta historia `scopes` se
 * guardaba en `api_keys` y `pulse_whoami` lo mostraba, pero ninguna tool lo
 * verificaba: cualquier key con cualquier scope podía llamar cualquier tool.
 */
export type McpScope =
  | 'issues:read'
  | 'issues:write'
  | 'projects:write'
  | 'comments:write'
  | 'comments:read'
  | 'reviews:read'
  | 'reviews:write'
  | 'runs:write'
  | 'runs:read'
  | 'salesforce:read'
  | 'deploy:write';

/** Perfil de una key de agente `role: 'dev'` conectada vía `agents.connectRepo`. */
export const DEV_SCOPES: McpScope[] = [
  'issues:read',
  'issues:write',
  'projects:write',
  'comments:write',
  'comments:read',
  'reviews:read',
  'runs:write',
  'runs:read',
  'salesforce:read',
];

/**
 * Perfil de una key de agente `role: 'qa'`: puede leer issues, comentar y
 * leer/emitir revisiones, pero no crear/borrar issues, cambiar su status o
 * asignación, ni tocar proyectos.
 */
export const QA_SCOPES: McpScope[] = [
  'issues:read',
  'comments:write',
  'comments:read',
  'reviews:read',
  'reviews:write',
  'runs:write',
  'runs:read',
  // El QA necesita la org tanto como el dev: verificar que un campo existe o
  // que un flow quedó activo es parte de revisar.
  'salesforce:read',
];

/**
 * Perfil de la key que `environments.connectRepo` deja en el repo como
 * `PULSE_DEPLOY_MCP_KEY` (O3/TES-253). Sólo abre y cierra deploys: el workflow
 * de deploy no necesita leer issues, y una key en un repo del cliente tiene
 * que poder lo mínimo.
 */
export const DEPLOY_SCOPES: McpScope[] = ['deploy:write'];

/**
 * Scope requerido por cada tool MCP, verificado centralmente antes de
 * ejecutar el handler (ver `buildMcpTransport` en `server.ts`). Una tool sin
 * entrada acá no requiere ningún scope — es el caso de `pulse_whoami`, que
 * tiene que funcionar aun para una key sin scopes, así se puede diagnosticar.
 */
export const TOOL_SCOPES: Record<string, McpScope> = {
  pulse_list_teams: 'issues:read',
  pulse_list_projects: 'issues:read',
  pulse_get_project: 'issues:read',
  pulse_list_issues: 'issues:read',
  pulse_get_epic: 'issues:read',
  pulse_get_issue: 'issues:read',
  pulse_list_labels: 'issues:read',
  pulse_list_members: 'issues:read',
  pulse_list_agents: 'issues:read',
  pulse_list_cycles: 'issues:read',
  pulse_list_activity: 'issues:read',
  pulse_get_review_context: 'reviews:read',
  pulse_list_comments: 'comments:read',
  pulse_list_runs: 'runs:read',
  // Lo llama el workflow al arrancar, con la key del agente (dev o QA): va bajo
  // `issues:read`, que los dos perfiles tienen, y no bajo `runs:read`.
  pulse_get_run_config: 'issues:read',

  pulse_next_task: 'issues:write',
  pulse_claim_issue: 'issues:write',
  pulse_release_issue: 'issues:write',
  pulse_update_issue: 'issues:write',
  pulse_update_issue_status: 'issues:write',
  pulse_create_issue: 'issues:write',
  pulse_move_issue: 'issues:write',
  pulse_flag_ambiguity: 'issues:write',
  pulse_create_branch: 'issues:write',
  pulse_link_pr: 'issues:write',
  pulse_request_repo_work: 'issues:write',
  pulse_report_pending_work: 'issues:write',
  pulse_resolve_finding: 'issues:write',
  pulse_report_criteria: 'issues:write',

  pulse_create_project: 'projects:write',

  pulse_comment_issue: 'comments:write',

  pulse_next_review: 'reviews:write',
  pulse_submit_review: 'reviews:write',
  pulse_report_review_incomplete: 'reviews:write',

  pulse_report_run: 'runs:write',

  // Lectura de una org de Salesforce (O2/TES-252), en `tools/salesforce.ts`.
  pulse_sf_list_orgs: 'salesforce:read',
  pulse_sf_query: 'salesforce:read',
  pulse_sf_tooling_query: 'salesforce:read',
  pulse_sf_describe: 'salesforce:read',
  pulse_sf_limits: 'salesforce:read',

  // Workflow de deploy (O3/TES-253), en `tools/deployments.ts`.
  pulse_start_deployment: 'deploy:write',
  // Lectura de la evidencia de deploy/validación: la necesitan dev y QA, que
  // tienen `issues:read`; la key del workflow no.
  pulse_get_deployment: 'issues:read',
  pulse_report_deployment: 'deploy:write',
};

/**
 * Todas las tools registradas por `registerReadTools`/`registerWriteTools`,
 * usado por `pulse_whoami` (D22/TES-218) para decirle a un agente qué puede
 * llamar con los scopes que tiene, antes de intentarlo. `pulse_whoami` en sí
 * no está en `TOOL_SCOPES` (no requiere ningún scope) así que se agrega acá a
 * mano.
 */
export const ALL_TOOL_NAMES: string[] = ['pulse_whoami', ...Object.keys(TOOL_SCOPES)];
