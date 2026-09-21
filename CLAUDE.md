# CLAUDE.md — pulse-backend

Backend de **Pulse**, un issue tracker pensado para desarrollar con agentes de IA. Este repo es Firebase Cloud Functions (v2, TypeScript) + reglas e índices de Firestore. El frontend vive en el repo hermano `rafaeldavid20/pulse-app`.

Proyecto Firebase: `pulse-app-93`. Región: `us-east4`. Node 20 (`engines.node`).

## Comandos

```bash
cd functions
npm run build        # tsc -> lib/   (correlo antes de deployar o shellear)
npm run build:watch
npm run logs         # firebase functions:log

cd ..
npm run deploy       # firebase deploy --only functions,firestore
```

No hay suite de tests configurada. `functions/lib/` es salida compilada y está gitignoreada.

## Lo que hay que saber antes de tocar nada

### `domain.generated.ts` no se edita a mano

`functions/src/common/domain.generated.ts` es una **copia generada** de `pulse-app/src/types/domain.ts`, que es la fuente única del modelo de dominio. Para cambiar un tipo compartido (`Issue`, `Project`, `Agent`): editás el archivo en `pulse-app`, corrés `npm run sync:types` ahí, y commiteás en los dos repos. `npm run lint` de `pulse-app` falla si los dos archivos divergen.

### Toda escritura de dominio es una Platform Action

No hay escrituras directas a Firestore desde el cliente para `issues`, `projects`, `labels` ni `comments`: las reglas son `allow write: if false`. Todo pasa por el callable `pulsePlatformAction`.

Agregar una mutación son cuatro pasos: una subclase de `PlatformActionHandler` en `actions/<dominio>/<accion>.ts`, un `case` en `router/platform-actions-router.ts`, el código en la union `PlatformActionCode` (`common/platform-actions/interfaces.ts`), y —si la tiene que poder llamar un agente— una tool en `mcp/tools/write.ts` con su entrada en `TOOL_SCOPES`.

`PlatformActionHandler.run()` da idempotencia por `actionID`, autorización y auditoría en `platform_actions`. La `authorize()` por defecto **no** habilita al caller de sistema: una acción que necesita correr sin humano tiene que opinar explícitamente (hoy sólo `github.syncFromWebhook`, protegida por la firma HMAC del webhook).

### El MCP es la única puerta de los agentes

`pulseMcp` expone Pulse por Model Context Protocol. Todas las tools sacan el `workspaceId` del `McpPrincipal` autenticado, **nunca del input del modelo** — es el invariante que impide que una key lea otro workspace pidiéndolo.

`zod` está pineado en `^4`, no `^3`: con 3.25.x + TS 5.9 + esta versión del SDK aparece `TS2589` en cualquier tool con `inputSchema` no vacío. No lo "arregles" bajando a `^3`.

### Los workflows del repo del cliente son generados

`.github/workflows/pulse-agent.yml` y `pulse-qa.yml` los escribe `agents.connectRepo` desde las plantillas de `functions/src/github/templates/`. **Editarlos a mano no sirve**: la próxima reconexión los pisa. Si cambiás una plantilla, subí su `WORKFLOW_VERSION` / `QA_WORKFLOW_VERSION` y acordate de que los repos ya conectados siguen con la versión vieja hasta que alguien los reconecte desde Settings.

Corolario que costó caro: los prompts y las listas de tools **ya no viven en el `.yml`**. El run los pide al arrancar con `pulse_get_run_config` (`functions/src/run-config/`). Un cambio de instrucciones no debería volver a requerir tocar ningún repo.

### El estado de un issue lo mueven los webhooks

Rama pusheada → `in_progress`. PR abierto → `in_review`. PR mergeado → `done`. Con varios repos, el estado sale del conjunto de PRs, no de un evento suelto.

Hay un guard de override manual: si una persona movió el status a algo distinto de `git.lastSyncedStatus`, el webhook no lo pisa. Por eso **toda transición hecha desde el backend tiene que dejar `git.lastSyncedStatus` al día**, o el issue deja de sincronizar.

El merge dejó de ser suficiente para cerrar: un criterio declarado `not_met` sin issue de seguimiento, o un pendiente sin materializar, frenan el cierre (ver la sección de trabajo pendiente en el README).

## Convenciones de código

- **Comentarios que explican el porqué, no el qué.** Casi todo comentario largo de este repo documenta una decisión o un bug que costó encontrar. Cuando cambies algo que un comentario explica, actualizá el comentario.
- Mensajes de error y de UI en castellano; nombres de código en inglés.
- Errores de cara al agente: decí qué falta y cómo obtenerlo (`scope 'comments:read' requerido`), no "unauthorized".
- `cleanUndefined` antes de escribir en Firestore.

## Cómo se trabaja este repo

El backlog de verdad está **en Pulse**, no en los archivos de plan. Antes de implementar un issue leé su descripción **y sus comentarios** (`pulse_list_comments`): ahí suele estar la decisión que falta. Si algo no se puede decidir desde el código, `pulse_flag_ambiguity` en vez de adivinar. Si queda trabajo que ningún run puede hacer, `pulse_report_pending_work` — escribirlo sólo en el cuerpo del PR no sirve, el merge cierra el issue y ese texto no lo lee nadie.
