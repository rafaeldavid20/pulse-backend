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
  | 'reviews:read'
  | 'reviews:write'
  | 'runs:write';

/** Perfil de una key de agente `role: 'dev'` conectada vía `agents.connectRepo`. */
export const DEV_SCOPES: McpScope[] = [
  'issues:read',
  'issues:write',
  'projects:write',
  'comments:write',
  'reviews:read',
  'runs:write',
];

/**
 * Perfil de una key de agente `role: 'qa'`: puede leer issues, comentar y
 * leer/emitir revisiones, pero no crear/borrar issues, cambiar su status o
 * asignación, ni tocar proyectos.
 */
export const QA_SCOPES: McpScope[] = ['issues:read', 'comments:write', 'reviews:read', 'reviews:write', 'runs:write'];

/**
 * Scope requerido por cada tool MCP, verificado centralmente antes de
 * ejecutar el handler (ver `buildMcpTransport` en `server.ts`). Una tool sin
 * entrada acá no requiere ningún scope — es el caso de `pulse_whoami`, que
 * tiene que funcionar aun para una key sin scopes, así se puede diagnosticar.
 */
export const TOOL_SCOPES: Record<string, McpScope> = {
  pulse_list_teams: 'issues:read',
  pulse_list_projects: 'issues:read',
  pulse_list_issues: 'issues:read',
  pulse_get_epic: 'issues:read',
  pulse_get_issue: 'issues:read',
  pulse_get_review_context: 'reviews:read',

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
  pulse_resolve_finding: 'issues:write',
  pulse_report_criteria: 'issues:write',

  pulse_create_project: 'projects:write',

  pulse_comment_issue: 'comments:write',

  pulse_next_review: 'reviews:write',
  pulse_submit_review: 'reviews:write',
  pulse_report_review_incomplete: 'reviews:write',

  pulse_report_run: 'runs:write',
};
