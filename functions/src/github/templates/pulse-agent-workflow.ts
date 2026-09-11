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
export const WORKFLOW_VERSION = 2;

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
        id: claude
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

      - name: Reportar el run en Pulse
        # Corre siempre que el run no se haya cancelado a mano, termine como
        # termine la sesión del modelo. Hubo runs que reclamaron el issue y
        # terminaron en ~9 turnos sin rama ni comentario, y la instrucción de
        # "comentá siempre" del prompt depende de que el modelo obedezca. Este
        # paso no: lee el transcript que expone la action y deja un resumen en
        # el issue.
        #
        # El resumen va a Pulse (privado) y NO se imprime acá: el repo es
        # público y sus logs también, que es por lo que se sacó
        # show_full_output. Si el run terminó sin PR, libera el issue para que
        # no quede trabado en "En progreso". No corre en cancelaciones: cancelar
        # un run duplicado liberaría el issue que el otro está trabajando.
        if: \${{ !cancelled() }}
        env:
          PULSE_AGENT_MCP_KEY: \${{ secrets.PULSE_AGENT_MCP_KEY }}
          EXECUTION_FILE: \${{ steps.claude.outputs.execution_file }}
          CLAUDE_OUTCOME: \${{ steps.claude.outcome }}
          ISSUE_IDENTIFIER: \${{ github.event.client_payload.issueIdentifier }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          python3 - <<'PY'
          import json, os, time, urllib.request
          NL = chr(10)
          MCP = 'https://us-east4-pulse-app-93.cloudfunctions.net/pulseMcp'
          KEY = os.environ.get('PULSE_AGENT_MCP_KEY', '')
          IDENT = os.environ.get('ISSUE_IDENTIFIER', '')
          DRY = os.environ.get('PULSE_REPORT_DRY_RUN') == '1'

          def load(path):
              try:
                  raw = open(path).read().strip()
              except Exception:
                  return []
              try:
                  data = json.loads(raw)
                  return data if isinstance(data, list) else [data]
              except Exception:
                  out = []
                  for line in raw.splitlines():
                      try:
                          out.append(json.loads(line))
                      except Exception:
                          pass
                  return out

          msgs = load(os.environ.get('EXECUTION_FILE') or '')
          tools, names, errors = {}, {}, []
          final, turns, subtype, is_error = '', None, '', None
          for m in msgs:
              kind = m.get('type')
              content = (m.get('message') or {}).get('content') or []
              if kind == 'assistant':
                  for c in content:
                      if isinstance(c, dict) and c.get('type') == 'tool_use':
                          n = c.get('name', '?')
                          tools[n] = tools.get(n, 0) + 1
                          names[c.get('id')] = n
              elif kind == 'user':
                  for c in content:
                      if isinstance(c, dict) and c.get('type') == 'tool_result' and c.get('is_error'):
                          body = c.get('content')
                          if isinstance(body, list):
                              body = ' '.join(x.get('text', '') for x in body if isinstance(x, dict))
                          errors.append(names.get(c.get('tool_use_id'), '?') + ': ' + str(body)[:200])
              elif kind == 'result':
                  final = str(m.get('result') or '')[:1500]
                  turns, subtype, is_error = m.get('num_turns'), m.get('subtype', ''), m.get('is_error')

          def call(name, args):
              body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                 'params': {'name': name, 'arguments': args}}).encode()
              # Reintentos: el primer request a un pulseMcp frío puede devolver
              # 400 (visto en los logs del 2026-09-11 16:07:13).
              for attempt in range(4):
                  try:
                      req = urllib.request.Request(MCP, data=body, headers={
                          'Authorization': 'Bearer ' + KEY,
                          'Content-Type': 'application/json',
                          'Accept': 'application/json, text/event-stream'})
                      with urllib.request.urlopen(req, timeout=30) as r:
                          d = json.loads(r.read().decode())
                          return json.loads(d['result']['content'][0]['text'])
                  except Exception:
                      time.sleep(3 * (attempt + 1))
              return None

          tool_list = ', '.join(k + ' x' + str(v) for k, v in sorted(tools.items())) or 'ninguna'
          lines = [
              '**Reporte automático del run** (' + os.environ.get('RUN_URL', '') + ')',
              '',
              '- Sesión: ' + (subtype or 'sin datos') + ' · turnos: ' + str(turns) + ' · error: ' + str(is_error) + ' · paso de Claude: ' + os.environ.get('CLAUDE_OUTCOME', '?'),
              '- Herramientas: ' + tool_list,
          ]
          if errors:
              lines.append('- Errores de herramientas (' + str(len(errors)) + '):')
              lines += ['  - ' + e for e in errors[:8]]
          if not msgs:
              lines.append('- No hay transcript: la sesión no llegó a arrancar o la action no dejó el archivo.')
          if final:
              lines += ['', 'Mensaje final del agente:', '', '> ' + final.replace(NL, NL + '> ')]

          if DRY:
              print(NL.join(lines))
              raise SystemExit(0)

          issue = ((call('pulse_get_issue', {'identifier': IDENT}) or {}).get('issue')) or {}
          refs = issue.get('gitRefs') or []
          has_pr = bool((issue.get('git') or {}).get('prNumber')) or any(r.get('prNumber') for r in refs)
          released = False
          if not has_pr and issue.get('status') in ('todo', 'in_progress'):
              lines += ['', 'El run terminó sin abrir un PR, así que el issue se liberó y quedó sin asignar. Para reintentar, asigná de nuevo al agente.']
              released = True
          ok = call('pulse_comment_issue', {'identifier': IDENT, 'body': NL.join(lines)}) is not None
          if released:
              call('pulse_release_issue', {'identifier': IDENT, 'reason': 'El run terminó sin abrir un PR. Ver el reporte automático en los comentarios.'})
          print('Reporte enviado a Pulse.' if ok else 'No se pudo enviar el reporte a Pulse.')
          PY
`;
}
