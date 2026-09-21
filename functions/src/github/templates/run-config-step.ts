/**
 * El paso que resuelve la configuración del run contra Pulse (TES-228 / M1).
 *
 * Es el reemplazo del prompt embebido: en vez de que cada repo lleve una copia
 * de las instrucciones —que envejece en silencio y sólo se actualiza
 * reconectando el repo—, el run las pide al arrancar. Lo comparten los tres
 * modos (task, rework, review) porque los tres tenían el mismo problema.
 *
 * Usa python3 (presente en los runners de GitHub) y un heredoc con el
 * delimitador entre comillas simples, así bash no expande nada del script: los
 * valores entran por variables de entorno, no interpolados en el texto.
 */
export function runConfigStep(opts: {
  /** Secret con la key de MCP del agente: distinto para dev y para QA. */
  keySecret: string;
  mode: 'task' | 'rework' | 'review';
  mcpUrl: string;
}): string {
  return `      - name: Resolver la configuración del run en Pulse
        id: runcfg
        env:
          PULSE_MCP_KEY: \${{ secrets.${opts.keySecret} }}
          PULSE_MCP_URL: ${opts.mcpUrl}
          PULSE_RUN_MODE: ${opts.mode}
          PULSE_ISSUE_IDENTIFIER: \${{ github.event.client_payload.issueIdentifier }}
          PULSE_HANDOFF_REPO: \${{ github.event.client_payload.handoffRepo }}
          PULSE_REVIEW_ATTEMPT: \${{ github.event.client_payload.reviewAttempt }}
        run: |
          python3 - <<'PULSE_RUN_CONFIG'
          import json, os, pathlib, sys, urllib.request

          URL = os.environ['PULSE_MCP_URL']
          KEY = os.environ['PULSE_MCP_KEY']
          IDENTIFIER = os.environ['PULSE_ISSUE_IDENTIFIER']


          def call(tool, args):
              body = json.dumps({
                  'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                  'params': {'name': tool, 'arguments': args},
              }).encode()
              req = urllib.request.Request(URL, data=body, headers={
                  'Authorization': 'Bearer ' + KEY,
                  'Content-Type': 'application/json',
                  'Accept': 'application/json, text/event-stream',
              })
              with urllib.request.urlopen(req, timeout=30) as resp:
                  payload = json.loads(resp.read().decode())
              if 'error' in payload:
                  raise RuntimeError(payload['error'])
              content = payload.get('result', {}).get('content') or []
              return json.loads(content[0]['text']) if content else {}


          def fail(reason):
              # Un run sin instrucciones no puede seguir como si nada: avisa en el
              # issue —que es donde alguien lo va a ver— y corta el job.
              print('::error::' + reason)
              try:
                  call('pulse_comment_issue', {
                      'identifier': IDENTIFIER,
                      'body': ('**El run no arrancó**: no se pudo resolver su configuración en Pulse.\\n\\n'
                               '\`' + reason + '\`\\n\\nEl issue queda como estaba; no se tocó el código.'),
                  })
              except Exception as comment_error:
                  print('::warning::tampoco se pudo comentar en el issue: %s' % comment_error)
              sys.exit(1)


          args = {'identifier': IDENTIFIER, 'mode': os.environ['PULSE_RUN_MODE']}
          if os.environ.get('PULSE_HANDOFF_REPO'):
              args['handoffRepo'] = os.environ['PULSE_HANDOFF_REPO']
          if os.environ.get('PULSE_REVIEW_ATTEMPT'):
              args['reviewAttempt'] = int(os.environ['PULSE_REVIEW_ATTEMPT'])

          try:
              config = call('pulse_get_run_config', args)
          except Exception as error:
              fail('pulse_get_run_config: %s' % error)

          if config.get('error'):
              fail('pulse_get_run_config: %s' % config['error'])
          if not config.get('prompt'):
              fail('la configuración vino sin prompt')

          # Los skills se materializan donde Claude Code los descubre. Hoy la
          # lista viene vacía (M1 construye el canal, M3/M4 el contenido), así
          # que esto no hace nada todavía — y cuando empiece a venir llena, no
          # hace falta tocar ningún repo.
          for skill in config.get('skills') or []:
              target = pathlib.Path('.claude/skills') / skill['name']
              target.mkdir(parents=True, exist_ok=True)
              (target / 'SKILL.md').write_text(skill['content'], encoding='utf-8')
              print('skill materializado: %s (%s)' % (skill['name'], skill.get('source', '?')))

          with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
              out.write('prompt<<PULSE_EOF_PROMPT\\n%s\\nPULSE_EOF_PROMPT\\n' % config['prompt'])
              out.write('allowed_tools=%s\\n' % ','.join(config['allowedTools']))
              out.write('disallowed_tools=%s\\n' % ','.join(config['disallowedTools']))
              out.write('max_turns=%s\\n' % (config.get('maxTurns') or ''))
              out.write('config_version=%s\\n' % config.get('version', ''))

          print('Configuración del run resuelta (version %s, modo %s, %d skills).'
                % (config.get('version'), config.get('mode'), len(config.get('skills') or [])))
          PULSE_RUN_CONFIG
`;
}

/**
 * Los argumentos de `claude_args` y el `prompt`, ya tomados de la salida del
 * paso de arriba. `--max-turns` sólo aparece si el modo lo definió.
 */
export const RUN_CONFIG_CLAUDE_ARGS = `          claude_args: |
            --mcp-config \${{ runner.temp }}/pulse-mcp.json
            --allowedTools \${{ steps.runcfg.outputs.allowed_tools }}
            --disallowedTools \${{ steps.runcfg.outputs.disallowed_tools }}
            \${{ steps.runcfg.outputs.max_turns && format('--max-turns {0}', steps.runcfg.outputs.max_turns) || '' }}
          prompt: \${{ steps.runcfg.outputs.prompt }}`;
