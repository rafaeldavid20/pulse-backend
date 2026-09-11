/**
 * Origen único del workflow que Pulse commitea en los repos conectados.
 *
 * Antes este YAML estaba duplicado a mano en cada repo, y ya había divergido
 * entre pulse-backend y pulse-app. Con `agents.connectRepo` escribiéndolo en N
 * repos, mantener copias a mano deja de ser viable.
 *
 * `WORKFLOW_VERSION` va estampada en un comentario del archivo generado: es lo
 * que permite después detectar repos que quedaron con una versión vieja y
 * ofrecer actualizarlos, sin tener que diffear el YAML entero.
 */
export const WORKFLOW_VERSION = 1;

export const WORKFLOW_PATH = '.github/workflows/pulse-agent.yml';

export function renderAgentWorkflow(): string {
  return `name: Pulse Agent

# GENERADO POR PULSE — pulse-agent-workflow-version: ${WORKFLOW_VERSION}
#
# Lo escribe la acción \`agents.connectRepo\` al conectar un agente a este repo.
# Editalo desde Pulse, no a mano: una reconexión o una actualización de versión
# lo sobrescribe.
#
# Lo dispara \`agentDispatchTrigger\` (pulse-backend,
# functions/src/triggers/agent-dispatch.ts) vía
# \`POST /repos/{owner}/{repo}/dispatches\` cuando un issue con un agente en
# \`autonomousMode\` pasa a \`todo\`. No corre en push ni en PR: solo en ese evento.
#
# A qué repo llega el dispatch lo decide la cascada issue -> épica -> agente
# (\`common/utils/repo-resolution.ts\`).
#
# Secrets requeridos en ESTE repo:
#   PULSE_AGENT_MCP_KEY      — lo provisiona Pulse al conectar.
#   CLAUDE_CODE_OAUTH_TOKEN  — lo ponés vos: es tuyo y está atado a tu
#                              suscripción de Claude, Pulse no lo guarda.
on:
  repository_dispatch:
    types: [pulse_task]

jobs:
  work-on-issue:
    # Varios runners escuchan el mismo tipo de evento y cada uno filtra por el
    # suyo, en vez de inventar un tipo de dispatch por proveedor. \`== ''\` cubre
    # los dispatches viejos, anteriores a que el trigger mandara \`agentKind\`.
    if: \${{ github.event.client_payload.agentKind == 'claude' || github.event.client_payload.agentKind == '' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: read
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - name: Write Pulse MCP config
        # Un archivo, no un string inline en claude_args: el header
        # "Bearer <key>" tiene un espacio, y no vale la pena confiar en cómo el
        # parser de argumentos de la acción tokeniza claude_args.
        env:
          PULSE_AGENT_MCP_KEY: \${{ secrets.PULSE_AGENT_MCP_KEY }}
        run: |
          cat > "$RUNNER_TEMP/pulse-mcp.json" <<EOF
          {
            "mcpServers": {
              "pulse": {
                "type": "http",
                "url": "https://us-east4-pulse-app-93.cloudfunctions.net/pulseMcp",
                "headers": { "Authorization": "Bearer \${PULSE_AGENT_MCP_KEY}" }
              }
            }
          }
          EOF

      - name: Run Claude Code on the dispatched issue
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # El repository_dispatch lo dispara agentDispatchTrigger vía la
          # GitHub App, no un humano — claude-code-action bloquea por default
          # los workflows iniciados por bots.
          allowed_bots: pulse-app-agent
          claude_args: |
            --mcp-config \${{ runner.temp }}/pulse-mcp.json
            --allowedTools mcp__pulse,Bash,Read,Edit,Write,Glob,Grep
          prompt: |
            Usá el MCP de Pulse para trabajar el issue con id
            "\${{ github.event.client_payload.issueId }}"
            (identifier \${{ github.event.client_payload.issueIdentifier }}).

            Reclamalo con pulse_claim_issue (ya está en 'todo' y asignado a vos, no hace falta
            pulse_next_task), leé su descripción y comentarios completos, creá una rama con
            pulse_create_branch, implementá los cambios descritos, commiteá y pusheá, abrí un PR
            y linkealo con pulse_link_pr, y comentá el progreso con pulse_comment_issue. No pases
            el issue a in_review vos mismo — eso lo hace el webhook de GitHub automáticamente
            cuando el PR se abre.

            Aunque el issue ya tenga una rama registrada, verificá que exista en este repo
            (git ls-remote origin <rama>); si no existe, creá una nueva con pulse_create_branch.

            Si en algún momento no podés avanzar —la rama no existe, el cambio no corresponde
            a este repo, falta información, falla el build—, comentá en el issue qué te
            bloqueó con pulse_comment_issue y liberalo con pulse_release_issue indicando el
            motivo. Nunca termines la sesión sin dejar un comentario en el issue: es la única
            forma de que alguien sepa qué pasó, porque el detalle de esta sesión no se guarda
            en los logs.

            Si el repo no corresponde al trabajo descrito, no improvises: comentá el problema
            con pulse_comment_issue y terminá sin crear rama ni PR.
`;
}
