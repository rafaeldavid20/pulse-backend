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

          # Los skills que Pulse gestiona (M4) se materializan donde Claude Code
          # los descubre, junto a los que el cliente ya tenga en su repo (M3).
          # Un skill del repo con el mismo nombre NO se pisa: el repo es la
          # fuente que el cliente controla más de cerca, y que Pulse le
          # sobrescriba un archivo versionado sería una sorpresa desagradable.
          for skill in config.get('skills') or []:
              target = pathlib.Path('.claude/skills') / skill['name']
              skill_file = target / 'SKILL.md'
              if skill_file.exists():
                  print('::notice::skill %s ya existe en el repo: gana el del repo, se ignora el de Pulse' % skill['name'])
                  continue
              target.mkdir(parents=True, exist_ok=True)
              skill_file.write_text(skill['content'], encoding='utf-8')
              print('skill materializado: %s (%s)' % (skill['name'], skill.get('source', '?')))


          def frontmatter(text):
              # Parser mínimo a propósito: sólo se valida lo que hace falta para
              # que un skill sea invocable (name y description). Nada de traer
              # un parser de YAML a un runner por tres campos.
              if not text.startswith('---'):
                  return None
              end = text.find('\\n---', 3)
              if end == -1:
                  return None
              fields = {}
              for line in text[3:end].splitlines():
                  if ':' in line and not line.startswith(' '):
                      key, _, value = line.partition(':')
                      fields[key.strip()] = value.strip()
              return fields


          # Inventario de lo que el run tiene realmente disponible, del repo del
          # cliente y de Pulse. Un skill roto no puede fallar en silencio: el
          # agente simplemente no lo usaría y nadie entendería por qué el run
          # salió distinto.
          found, broken = [], []
          for skill_file in sorted(pathlib.Path('.claude/skills').glob('*/SKILL.md')):
              name = skill_file.parent.name
              try:
                  fields = frontmatter(skill_file.read_text(encoding='utf-8'))
              except Exception as read_error:
                  broken.append((name, 'no se pudo leer: %s' % read_error))
                  continue
              if fields is None:
                  broken.append((name, 'no tiene frontmatter (--- al principio del archivo)'))
              elif not fields.get('description'):
                  broken.append((name, 'el frontmatter no tiene \`description\`, así que el modelo no sabe cuándo usarlo'))
              else:
                  found.append(name)

          print('Skills disponibles para este run: %s' % (', '.join(found) if found else 'ninguno'))
          for name, problem in broken:
              print('::warning::skill %s ignorado: %s' % (name, problem))

          if broken:
              detail = '\\n'.join('- \`%s\`: %s' % (name, problem) for name, problem in broken)
              try:
                  call('pulse_comment_issue', {
                      'identifier': IDENTIFIER,
                      'body': ('**Skills ignorados en este run** — están en \`.claude/skills/\` pero no se pudieron cargar:'
                               '\\n\\n' + detail + '\\n\\nEl run siguió sin ellos.'),
                  })
              except Exception as comment_error:
                  print('::warning::no se pudo avisar de los skills rotos: %s' % comment_error)

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
