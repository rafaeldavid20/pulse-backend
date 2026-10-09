# Retiro de agentes GitHub Actions (TES-337)

## Comportamiento

- Dev, rework, handoff y QA requieren Runner local. Sin Runner, el issue queda con diagnóstico visible, sin reservar dispatch, intentos, presupuesto ni runs.
- `agents.connectRepo` permanece registrado para responder a clientes antiguos con el mensaje de migración; no provisiona recursos.
- Las claves API dedicadas de Actions (`agentId` y `connectedRepo`, sin `jobId`) reciben HTTP 403 en MCP. No se eliminan documentos ni se rechazan claves manuales, OAuth, Salesforce o jobs Runner.
- Se eliminan `pulse-agent.yml`, `pulse-qa.yml` y sus generadores. CI, deploy, publicación de Runner y los workflows Salesforce se conservan.
- Las conexiones antiguas quedan visibles como retiradas. Desconectar exige permisos existentes, comprueba que la clave pertenece al workspace/agente/repo y solo admite los nombres de secret y archivo conocidos. Conserva `allowedRepos`, historial y sesiones locales.

## Orden de despliegue y limpieza

1. Revisar y fusionar el backend primero. Su pipeline despliega el cierre de dispatch y de credenciales antiguas. Verificar que terminó antes de dar el retiro por activo.
2. Fusionar y desplegar el frontend. Los agentes sin Runner muestran configuración pendiente; vincular un Runner y diagnosticar su identidad, sesión y acceso al proyecto.
3. Comprobar un job dev y una revisión QA con Runner. Comprobar también que un agente antiguo sin Runner muestra diagnóstico sin jobs o presupuesto nuevo.
4. Retirar cada conexión antigua desde Configuración → Agentes. Se revoca únicamente su clave dedicada y se elimina su secret MCP. Los warnings de limpieza de GitHub se deben resolver antes de considerar completa la limpieza. No usar borrados globales por `agentId` ni borrar la clave manual de este workspace.
5. Los workflows en los dos repos de Pulse se eliminan con estos PRs. En repos externos retirar exclusivamente `.github/workflows/pulse-agent.yml` y `.github/workflows/pulse-qa.yml`, mediante PR o desconexión explícita con `removeWorkflow: true`. No borrar CI/deploy ni `pulse-deploy.yml`.
6. Los tokens de proveedor previamente cargados en GitHub (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) pertenecen al usuario. Inventariar sus consumidores y retirar los secrets únicamente donde ya no se usan. No revocar sesiones locales ni borrar otros secrets.
7. Conservar la App central: sirve a webhooks, QA e integración Salesforce. Suprimir permisos únicamente tras inventariar sus consumidores; este cambio no los modifica.

## TES-311

El job real conservó cambios en archivos de workflows de agentes, por lo que la App local rechazó su publicación. Esos cambios y cualquier heartbeat específico de Actions deben retirarse al preparar sus PRs; conservar la actividad de Runner y UI. No modificar el manifest ni sustituir los commits de recuperación firmados. Esta deprecación no publica ni aprueba por sí misma el trabajo de TES-311.

## Validación

Pruebas de regresión para bloqueo dev/rework/handoff, QA automático/manual sin fallback, rechazo de clientes antiguos y aislamiento de credenciales. Se mantienen las pruebas de Runner task, continuaciones, QA de proyecto, publicación y recuperación.
