/**
 * Workflow que `environments.connectRepo` commitea en el repo de un proyecto
 * Salesforce (O3/TES-253): un push a la `trackingBranch` de un entorno
 * despliega el delta a su org, un PR se valida check-only contra el primer
 * entorno de la cadena (O5/TES-255), y un `repository_dispatch`
 * `pulse_deploy` corre validaciones y quick deploys (O4).
 *
 * Mismo contrato de versionado que `github/templates/pulse-agent-workflow.ts`:
 * `DEPLOY_WORKFLOW_VERSION` va estampada en el archivo; si cambia, los repos ya
 * atados siguen con la vieja hasta que alguien los vuelva a atar.
 *
 * Reglas que no se negocian, porque los repos pueden ser públicos y sus logs
 * también:
 * - La credencial entra por stdin (`--sfdx-url-stdin`), nunca como argumento.
 * - El `--json` del CLI va a un archivo y a Pulse, nunca al log: trae nombres
 *   de componentes y mensajes de error de la org del cliente.
 * - El reporte a Pulse reintenta 4 veces, como el del agente: el primer request
 *   a un `pulseMcp` frío puede fallar.
 */

// v2 (TES-255): validación de PRs, login sin salida y 403 legible al commitear.
export const DEPLOY_WORKFLOW_VERSION = 2;

export const DEPLOY_WORKFLOW_PATH = '.github/workflows/pulse-deploy.yml';

export const DEPLOY_MCP_SECRET_NAME = 'PULSE_DEPLOY_MCP_KEY';

/** Pineadas: un minor nuevo del CLI cambió más de una vez la forma del `--json`. */
const SF_CLI_VERSION = '2.150.6';
const SGD_VERSION = '6.45.1';

/** Helper de Python compartido por los pasos que hablan con Pulse. */
const PY_CALL = `
          import json, os, time, urllib.request
          MCP = 'https://us-east4-pulse-app-93.cloudfunctions.net/pulseMcp'
          KEY = os.environ.get('${DEPLOY_MCP_SECRET_NAME}', '')

          def call(name, args):
              body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                                 'params': {'name': name, 'arguments': args}}).encode()
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
              return None`;

export function renderDeployWorkflow(trackingBranches: string[]): string {
  const branches = [...new Set(trackingBranches)].sort();
  if (branches.length === 0) throw new Error('No hay ramas de entorno para el workflow de deploy.');
  const branchList = branches.map((b) => JSON.stringify(b)).join(', ');

  return `name: Pulse Deploy
# GENERADO POR PULSE — pulse-deploy-workflow-version: ${DEPLOY_WORKFLOW_VERSION}
# No lo edites a mano: se reescribe al volver a atar un entorno desde Pulse
# (Configuración → Salesforce).

on:
  push:
    branches: [${branchList}]
  pull_request:
    types: [opened, synchronize, reopened]
  repository_dispatch:
    types: [pulse_deploy]

# Un deploy por entorno a la vez: el siguiente espera en vez de pisarlo. Una
# validación de PR, en cambio, se cancela si llega un push nuevo al mismo PR:
# el Deployment se reutiliza y la validación que importa es la del último commit.
concurrency:
  group: \${{ github.event_name == 'pull_request' && format('pulse-validate-{0}', github.event.pull_request.number) || format('pulse-deploy-{0}', github.event.client_payload.environment || github.ref_name) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.event.client_payload.sha || github.sha }}

      - name: Pedir el entorno a Pulse
        id: start
        env:
          ${DEPLOY_MCP_SECRET_NAME}: \${{ secrets.${DEPLOY_MCP_SECRET_NAME} }}
          EVENT: \${{ github.event_name }}
          BRANCH: \${{ github.ref_name }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_HEAD_REF: \${{ github.head_ref }}
          P_ENV: \${{ github.event.client_payload.environment }}
          P_MODE: \${{ github.event.client_payload.mode }}
          P_TRIGGER: \${{ github.event.client_payload.trigger }}
          P_DEPLOYMENT: \${{ github.event.client_payload.deploymentId }}
          P_VALIDATION: \${{ github.event.client_payload.validationId }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          python3 - <<'PY'
          ${PY_CALL.trim()}

          dispatch = os.environ.get('EVENT') == 'repository_dispatch'
          pr = os.environ.get('EVENT') == 'pull_request'
          out = open(os.environ['GITHUB_OUTPUT'], 'a')
          if pr and not KEY:
              # PR desde un fork: GitHub no le pasa los secrets. No hay nada que
              # validar sin credencial, y no es un error del PR.
              out.write('proceed=false' + chr(10))
              print('PR sin acceso a los secrets del repo (¿fork?): no se valida contra la org.')
              raise SystemExit(0)
          args = {
              'repoFullName': os.environ.get('GITHUB_REPOSITORY', ''),
              'sha': os.popen('git rev-parse HEAD').read().strip(),
              'runUrl': os.environ.get('RUN_URL', ''),
              'mode': (os.environ.get('P_MODE') if dispatch else '') or 'deploy',
              'trigger': (os.environ.get('P_TRIGGER') if dispatch else '') or ('manual' if dispatch else 'push'),
          }
          if pr:
              args['trigger'] = 'pr_validation'
              args['mode'] = 'validate'
              args['branch'] = os.environ.get('PR_HEAD_REF', '')
              args['prNumber'] = int(os.environ.get('PR_NUMBER') or 0)
          elif dispatch:
              args['environment'] = os.environ.get('P_ENV', '')
              if os.environ.get('P_DEPLOYMENT'):
                  args['deploymentId'] = os.environ['P_DEPLOYMENT']
              if os.environ.get('P_VALIDATION'):
                  args['validationId'] = os.environ['P_VALIDATION']
          else:
              args['branch'] = os.environ.get('BRANCH', '')

          res = call('pulse_start_deployment', args)
          if not res or res.get('error'):
              # El mensaje de error de Pulse no trae datos de la org: se puede mostrar.
              print('Pulse no autorizó el deploy: ' + str((res or {}).get('error', 'sin respuesta de Pulse')))
              raise SystemExit(1)
          proceed = bool(res.get('proceed'))
          out.write('proceed=' + ('true' if proceed else 'false') + chr(10))
          for k in ('deploymentId', 'secretName', 'fromSha', 'testLevel', 'mode', 'validationId'):
              out.write(k + '=' + str(res.get(k) or '') + chr(10))
          print(res.get('message') or ('Deploy ' + str(res.get('mode')) + ' a ' + str(res.get('envKey'))))
          PY

      - name: Instalar Salesforce CLI
        if: steps.start.outputs.proceed == 'true'
        run: |
          npm install --global @salesforce/cli@${SF_CLI_VERSION} > /dev/null
          echo y | sf plugins install sfdx-git-delta@${SGD_VERSION} > /dev/null

      - name: Login en la org
        if: steps.start.outputs.proceed == 'true'
        env:
          SF_AUTH_URL: \${{ secrets[steps.start.outputs.secretName] }}
        run: |
          if [ -z "$SF_AUTH_URL" ]; then
            echo "Falta el secret \${{ steps.start.outputs.secretName }}: volvé a atar el entorno desde Pulse."
            exit 1
          fi
          # Sin salida: un error de login del CLI puede traer datos de la org, y
          # el log del repo puede ser público.
          if ! echo "$SF_AUTH_URL" | sf org login sfdx-url --sfdx-url-stdin --alias pulse-target --set-default > /dev/null 2>&1; then
            echo "No se pudo loguear en la org: la credencial del secret puede haber caducado. Reconectá la org y volvé a atar el repo desde Pulse."
            exit 1
          fi

      - name: Desplegar
        id: deploy
        if: steps.start.outputs.proceed == 'true'
        env:
          FROM_SHA: \${{ steps.start.outputs.fromSha }}
          IS_PR: \${{ github.event_name == 'pull_request' }}
          BASE_REF: \${{ github.base_ref }}
          MODE: \${{ steps.start.outputs.mode }}
          TEST_LEVEL: \${{ steps.start.outputs.testLevel }}
          VALIDATION_ID: \${{ steps.start.outputs.validationId }}
        run: |
          set +e
          OUT=.pulse-deploy.json
          if [ "$MODE" = "quick" ]; then
            sf project deploy quick --job-id "$VALIDATION_ID" --target-org pulse-target --wait 110 --json > "$OUT" 2>/dev/null
            echo "exit=$?" >> "$GITHUB_OUTPUT"; exit 0
          fi

          # Un PR se valida por lo que cambia: el delta desde el merge-base con la
          # rama destino, no desde lo que tiene desplegado la org.
          if [ "$IS_PR" = "true" ]; then
            FROM_SHA=$(git merge-base "origin/$BASE_REF" HEAD 2>/dev/null)
          fi

          TARGET=()
          if [ -n "$FROM_SHA" ] && git cat-file -e "$FROM_SHA^{commit}" 2>/dev/null; then
            mkdir -p .pulse-delta
            sf sgd source delta --from "$FROM_SHA" --to HEAD --output-dir .pulse-delta --generate-delta > /dev/null 2>&1
            PKG=.pulse-delta/package/package.xml
            DESTRUCTIVE=.pulse-delta/destructiveChanges/destructiveChanges.xml
            HAS_PKG=$(grep -c "<types>" "$PKG" 2>/dev/null || true)
            HAS_DEL=$(grep -c "<types>" "$DESTRUCTIVE" 2>/dev/null || true)
            if [ "\${HAS_PKG:-0}" = "0" ] && [ "\${HAS_DEL:-0}" = "0" ]; then
              echo '{"status":0,"result":{"status":"Succeeded","numberComponentsTotal":0,"numberComponentErrors":0},"pulseNoChanges":true}' > "$OUT"
              echo "No hay cambios de metadata desde el último deploy."
              echo "exit=0" >> "$GITHUB_OUTPUT"; exit 0
            fi
            TARGET=(--manifest "$PKG")
            if [ "\${HAS_DEL:-0}" != "0" ]; then TARGET+=(--post-destructive-changes "$DESTRUCTIVE"); fi
          else
            # Sin base conocida (primer deploy, o el sha ya no está en la
            # historia): se despliega todo lo que declara sfdx-project.json.
            for dir in $(jq -r '.packageDirectories[].path' sfdx-project.json); do TARGET+=(--source-dir "$dir"); done
          fi

          if [ "$MODE" = "validate" ]; then CMD=(sf project deploy validate); else CMD=(sf project deploy start); fi
          "\${CMD[@]}" "\${TARGET[@]}" --target-org pulse-target --test-level "$TEST_LEVEL" --ignore-warnings --wait 110 --json > "$OUT" 2>/dev/null
          echo "exit=$?" >> "$GITHUB_OUTPUT"

      - name: Reportar el deploy en Pulse
        # Corre aunque el deploy haya fallado; no en una cancelación a mano.
        if: \${{ !cancelled() && steps.start.outputs.deploymentId != '' && steps.start.outputs.proceed == 'true' }}
        env:
          ${DEPLOY_MCP_SECRET_NAME}: \${{ secrets.${DEPLOY_MCP_SECRET_NAME} }}
          DEPLOYMENT_ID: \${{ steps.start.outputs.deploymentId }}
          DEPLOY_EXIT: \${{ steps.deploy.outputs.exit }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          python3 - <<'PY'
          ${PY_CALL.trim()}

          try:
              raw = json.load(open('.pulse-deploy.json'))
          except Exception:
              raw = None
          result = (raw or {}).get('result') or {}
          details = result.get('details') or {}
          tests = details.get('runTestResult') or {}

          def listify(x):
              return x if isinstance(x, list) else ([x] if x else [])

          # Solo lo que Pulse necesita: el --json completo puede pasar varios MB.
          cli = {
              'status': result.get('status'),
              'id': result.get('id'),
              'numberComponentsTotal': result.get('numberComponentsTotal'),
              'numberComponentErrors': result.get('numberComponentErrors'),
              'numberTestsTotal': result.get('numberTestsTotal'),
              'numberTestErrors': result.get('numberTestErrors'),
              'componentFailures': [
                  {k: f.get(k) for k in ('componentType', 'fullName', 'problem', 'lineNumber', 'columnNumber')}
                  for f in listify(details.get('componentFailures'))][:50],
              'testFailures': [
                  {k: f.get(k) for k in ('name', 'methodName', 'message', 'stackTrace')}
                  for f in listify(tests.get('failures'))][:50],
              'codeCoverage': [
                  {k: c.get(k) for k in ('name', 'numLocations', 'numLocationsNotCovered')}
                  for c in listify(tests.get('codeCoverage'))],
              'noChanges': bool((raw or {}).get('pulseNoChanges')),
          }
          if raw is None:
              cli['message'] = 'El CLI no dejó un --json legible (exit ' + os.environ.get('DEPLOY_EXIT', '?') + ').'
          elif raw.get('status') not in (0, None) and not result:
              cli['message'] = str(raw.get('message') or raw.get('name') or 'Error del CLI')[:1000]

          ok = os.environ.get('DEPLOY_EXIT') == '0' and result.get('status') == 'Succeeded'
          res = call('pulse_report_deployment', {
              'deploymentId': os.environ['DEPLOYMENT_ID'],
              'status': 'succeeded' if ok else 'failed',
              'runUrl': os.environ.get('RUN_URL', ''),
              'cli': cli,
          })
          print('Deploy reportado en Pulse.' if res and not res.get('error') else 'No se pudo reportar el deploy en Pulse.')
          PY

      - name: Resultado
        if: steps.start.outputs.proceed == 'true'
        run: |
          if [ "\${{ steps.deploy.outputs.exit }}" != "0" ]; then
            echo "El deploy falló. El detalle está en Pulse (el log no lo muestra: el repo puede ser público)."
            exit 1
          fi
`;
}
