# pulse-backend

Firebase Cloud Functions y Security Rules para Pulse — Platform Actions Engine.

## Observabilidad con Argus

`pulsePlatformAction` y `pulseMcp` reportan fallos internos a Argus sin alterar
la respuesta ni el comportamiento de Pulse. El DSN vive exclusivamente en
Secret Manager como `PULSE_ARGUS_DSN`; no se agrega al frontend estático.

1. En Argus, crear un proyecto **Pulse Backend** y generar su DSN desde
   **Conexión e issues**.
2. Cargarlo en el proyecto Firebase de Pulse:

```bash
firebase functions:secrets:set PULSE_ARGUS_DSN --project pulse-app-93
```

3. Desplegar Functions. Un fallo de una acción o del transporte MCP aparecerá
   como issue en ese proyecto de Argus.

## Disparo autónomo de agentes (Fase 6)

Cuando un issue asignado a un agente con `autonomousMode` pasa a `todo`,
`agentDispatchTrigger` (`functions/src/triggers/agent-dispatch.ts`, un
`onDocumentWritten` sobre `issues/{issueId}`) dispara un evento
`repository_dispatch` (`event_type: pulse_task`) contra el repo destino, que
`.github/workflows/pulse-agent.yml` recoge para correr `claude-code-action`
con el MCP de Pulse configurado por header — sin que un humano tenga que
reclamar el issue manualmente.

### Secrets requeridos en el repo destino

- `CLAUDE_CODE_OAUTH_TOKEN` (o `ANTHROPIC_API_KEY`, alternativa soportada por
  `claude-code-action`) — credencial para correr Claude Code.
- `PULSE_AGENT_MCP_KEY` — API key con la que el workflow autentica contra el
  MCP de Pulse (`Authorization: Bearer ...`).

### Permisos de la GitHub App

La GitHub App usada para la instalación (`github_installations` en
Firestore) necesita, como mínimo:

- **Contents**: read & write (crear ramas, `checkout`, push).
- **Pull requests**: read & write (abrir el PR).
- **Actions**: read & write (`POST /repos/{owner}/{repo}/dispatches`
  requiere este permiso).

### Kill switches (obligatorios, no opcionales)

Sin estos, un ciclo issue creado → agente → PR → webhook → issue podría
quemar créditos indefinidamente:

- **`maxConcurrentIssues` por agente** (`agents/{agentId}`, default `1`):
  tope de issues `in_progress` simultáneos antes de saltear el dispatch.
- **Circuit breaker diario por workspace** (`agent_dispatch_counters`,
  `Workspace.dailyDispatchLimit` o `DAILY_DISPATCH_LIMIT = 5` en
  `dispatch-counter.ts` si no está seteado): tope de dispatches por workspace
  por día, sin importar cuántos agentes autónomos tenga.
- **`Workspace.agentsPaused`** (D8/TES-153): kill switch global — en `true`
  corta el dispatch sin tocar `enabled`/`autonomousMode` de cada agente. Se
  chequea en `checkWorkspaceDispatchBudget` (`common/utils/dispatch-counter.ts`),
  compartido por los caminos de dispatch de esta implementación: task y
  traspaso (`agent-dispatch.ts`), revisión automática (`qa-dispatch.ts`) y
  revisión manual (`reviews.rerun`). El re-trabajo automático del dev tras un
  `changes_requested` (D9/TES-205) todavía no despacha — hoy el issue queda en
  `in_progress` esperando intervención manual (ver la sección de D5 más
  abajo) — así que cuando D9 se construya, tiene que respetar este mismo kill
  switch.
- **Techo de USD por día y por issue** (D8/TES-153,
  `Workspace.dailyCostCapUsd`/`issueCostCapUsd`, sin tope si no están
  seteados): suman `agent_runs.costUsd` de hoy (o del issue) y bloquean el
  dispatch al llegar al techo. Inertes hasta que D15/TES-211 popule
  `costUsd` — hoy `agent_runs` solo registra `startedAt`.
- **Tope de runs por issue** (`Workspace.maxRunsPerIssue`, default
  `DEFAULT_MAX_RUNS_PER_ISSUE = 6` en `common/utils/issue-run-budget.ts`):
  cuenta TODOS los `agent_runs` de un issue (task + traspasos + QA), no solo
  los intentos de revisión — cubre bucles que nunca llegan a QA, como un
  traspaso que se re-pide. Al agotarse, escala a `needs_human` (reasigna al
  lead del proyecto o al creador, etiqueta `needs-human`) en vez de solo
  saltear el dispatch, porque a diferencia del resto de los guardarraíles acá
  arriba, un loop atascado en un solo issue nunca dispara el circuit breaker
  diario del workspace.
- **`workspaces.update`** (Platform Action, `minRole: 'admin'`): setea los
  cinco campos de arriba. **`workspaces.getAgentBudget`**: resumen de hoy
  ("3/5 dispatches · USD 4,20/10", desglosado por rol dev/qa) para el botón
  "Pausar agentes" y la sección de guardarraíles en Settings — necesario
  porque `agent_dispatch_counters`/`agent_runs` son Admin-SDK-only. Ninguna de
  las dos vive todavía en `pulse-app`; ver traspaso registrado en TES-153.

## Notificaciones (F1, D16)

`issueNotificationsTrigger` (`functions/src/triggers/notify-on-issue-write.ts`,
un `onDocumentWritten` sobre `issues/{issueId}`) genera notificaciones
`assigned` y `status_change`; `comments.create`
(`functions/src/actions/comments/create-comment.ts`) genera `comment` y
`mentioned` (parseo best-effort de `@algo` contra `userId`/`displayName`/email
de los miembros del workspace — no hay todavía un picker de menciones en el
frontend). `due_soon` es del modelo pero su generación es de F5.

El veredicto de una revisión de QA (D5/D6) se notifica directamente desde
donde se decide el desenlace, no infiriéndolo del rol del autor de un
comentario — cada uno tiene su propia audiencia:

- `review_result` (approved) → al creador del issue y al lead del proyecto
  (`reviews.submit`), con link a cada PR: "TES-X aprobado por QA, listo para
  merge".
- `needs_human` (intentos agotados, criterio no verificable, revisión
  incompleta o colgada — `reviews.submit`, `reviews.reportIncomplete` y
  `scheduled/review-sweeper.ts`) → al responsable resuelto por
  `resolveReviewLead` (lead del proyecto, o el creador si no hay lead).
  Exactamente una notificación por escalamiento; **no puede quedar apagada**
  por el mute de tipo por defecto (`UNMUTABLE_NOTIFICATION_TYPES` en
  `common/utils/notifications.ts`) — solo el mute puntual de ese issue lo
  filtra.
- `changes_requested` (`reviews.submit`) → al creador y al lead, pero es
  **opt-in**: por defecto nadie lo recibe (el loop se resuelve solo con el
  re-trabajo del dev), hay que prenderlo a mano vía
  `notifications.updatePreferences` (`OPT_IN_NOTIFICATION_TYPES`, guardado en
  `enabledNotificationTypes` del doc de membership, no en
  `mutedNotificationTypes`).

El modelo `Notification` vive en
`functions/src/common/utils/notifications.ts` hasta que se agregue a
`pulse-app/src/types/domain.ts` (la fuente única del resto del dominio) y se
sincronice a `domain.generated.ts` como todo lo demás.

Las acciones que pueden cambiar `status`/`assigneeId` de un issue
(`issues.update`, `.claim`, `.claimNext`, `.release`, `.requestRepoWork`,
`reviews.submit`, `.override`, y el sync de GitHub) estampan `updatedBy` junto
con `updatedAt` — es lo único que le permite al trigger saber quién hizo el
cambio y no notificarle a alguien su propia acción.

## Acciones y tools de revisión (D5)

`qaDispatchTrigger` (D4) dispara un run de QA que reclama la revisión y emite
un veredicto contra las mismas piezas que usa un dev:

- **Platform Actions**: `reviews.start` (claim con lock del intento que le
  tocó a este agente), `reviews.submit` (valida el veredicto contra
  `findings`/`criteriaResults` — no confía en un `decision` que mande el
  modelo — y aplica la transición), `reviews.override` (solo humanos, vía
  `pulsePlatformAction`, nunca MCP — "Aprobar igual" pisando el veredicto del
  QA), `reviews.resolveFinding` (el dev marca un finding `fixed`/`disputed`
  durante el re-trabajo de D9) y `reviews.reportCriteria` (la autoverificación
  del dev de D13, `issue.devSelfCheck`).
- **MCP**: `pulse_next_review`, `pulse_get_review_context` (issue, criterios
  aceptados, DoD del proyecto una vez exista D14, autoverificación del dev,
  findings de intentos anteriores, comentarios, y el diff de cada PR de
  `gitRefs` — paginado con `REVIEW_DIFF_SIZE_CAP`, o la lista de archivos si
  lo supera), `pulse_submit_review`, `pulse_resolve_finding` y
  `pulse_report_criteria`.
- `reviews.submit` exige que quien llama sea un agente `role: 'qa'` y que no
  sea el propio asignado dev del issue — que un tester no pueda aprobar su
  propio trabajo es la mitad del valor del diseño. Esta validación puntual es
  independiente de los scopes de abajo (D11/TES-207).
- `changes_requested` mueve el issue a `in_progress`; al llegar a
  `maxReviewAttempts` (o si el único problema es un criterio
  `unverifiable`) pasa a `needs_human`: se reasigna a `Project.leadId` (o al
  creador del issue si no hay lead, guardando el asignado anterior en
  `review.previousAssigneeId` para el botón "Devolver al agente" de D7) y se
  etiqueta `needs-human`. Ambas transiciones dejan `git.lastSyncedStatus` al
  día para que el guard de override manual de `sync-from-webhook.ts` no las
  confunda con un cambio hecho a mano (D10).
- Cada veredicto también se publica como una review `COMMENT` (nunca
  `APPROVE`) en cada PR del issue, con los findings inline en `file:line`
  cuando hay `file`/`line`, para quien mira el PR y no Pulse. Es best-effort:
  un fallo al publicar en GitHub no tumba `reviews.submit`.
- Lo que queda pendiente de otras historias del mismo épico: **D9**
  (TES-205) todavía no despacha el re-trabajo del dev cuando
  `review.state` pasa a `changes_requested` — hoy el issue queda en
  `in_progress` esperando ese dispatch. **D13**/**D14** son las que llenan
  `devSelfCheck` y `Project.definitionOfDone` con datos reales; hasta
  entonces `pulse_get_review_context` los devuelve vacíos.

## Scopes del MCP (D11, D22)

`functions/src/mcp/scopes.ts` mapea cada tool MCP a un scope requerido
(`TOOL_SCOPES`) y define los dos perfiles que `agents.connectRepo` asigna
según `agent.role`: **dev** (`issues:read`, `issues:write`, `projects:write`,
`comments:write`, `comments:read`, `reviews:read`, `runs:write`,
`runs:read`) y **qa** (`issues:read`, `comments:write`, `comments:read`,
`reviews:read`, `reviews:write`, `runs:write`, `runs:read` — sin
`issues:write` ni `projects:write`, así que no puede crear/borrar issues ni
cambiar su status o asignación).

`buildMcpTransport` (`mcp/server.ts`) envuelve `server.tool`/`registerTool`
antes de registrar ninguna tool: si el `principal` no tiene el scope que
`TOOL_SCOPES` exige, devuelve un `CallToolResult` con `isError: true` (mensaje
`scope '<scope>' requerido`) y el handler real de la tool ni se ejecuta. Es un
único punto de enforcement — las tools en `mcp/tools/*.ts` no saben que los
scopes existen. Una tool sin entrada en `TOOL_SCOPES` (como `pulse_whoami`) no
requiere ningún scope. `pulse_whoami` además devuelve `tools`: los nombres de
todas las tools que los scopes de la key actual habilitan, para que un agente
sepa con qué cuenta antes de intentar (`ALL_TOOL_NAMES` en `scopes.ts`).

Las keys existentes creadas antes de esta historia (sin `reviews:*` en su
array de `scopes`) siguen funcionando igual que antes para todo lo que ya
podían hacer. Los tokens OAuth (`claude.ai`, Fase 7) no cambian: mantienen
`DEFAULT_OAUTH_SCOPES` tal cual estaba.

`comments:read` y `runs:read` (D22/TES-218) son scopes nuevos: una key emitida
antes de este cambio no los tiene y `pulse_list_comments`/`pulse_list_runs` le
van a devolver el error de scope faltante hasta que se migre. Correr
(dry-run por defecto, `--apply` para escribir):

```bash
node functions/scripts/migrate-api-key-scopes.mjs [--apply]
```

Una key con `agentId` se reemplaza por el perfil canónico de su rol
(`DEV_SCOPES`/`QA_SCOPES`); una key personal (sin `agentId`, usada por un
humano operando el backlog por MCP) solo recibe los dos scopes de lectura
nuevos, sin tocar el resto de su `scopes`.

## Superficie de lectura del MCP (D22)

`mcp/tools/read.ts` orquesta tres archivos por dominio — se partió cuando
`read.ts` solo (todas las tools de lectura juntas) hubiera superado las ~400
líneas que disparan el TS2589 de `zod ^4` en un `inputSchema` no vacío (ver
comentario de cabecera en cada archivo; el fix es el overload `server.tool()`
en vez de `registerTool()`, no cambia con el split):

- **`read-issues.ts`**: `pulse_list_issues`, `pulse_get_epic`,
  `pulse_get_issue`, `pulse_list_comments`, `pulse_list_activity`,
  `pulse_get_review_context`.
- **`read-workspace.ts`**: `pulse_list_teams`, `pulse_list_projects`,
  `pulse_get_project`, `pulse_list_labels`, `pulse_list_members`,
  `pulse_list_agents`, `pulse_list_cycles`.
- **`read-runs.ts`**: `pulse_list_runs`.

`pulse_list_comments` es la tool que cierra el loop de ambigüedad de
`pulse_flag_ambiguity`: antes, leer lo que alguien respondió en los
comentarios de un issue etiquetado `ambigua` exigía `pulse_get_review_context`
(scope `reviews:read`, pensado para QA, y que además arrastra el diff de cada
PR — caro y semánticamente equivocado para "¿qué se dijo acá?"). Resuelve
`authorId` a nombre vía `pulse_list_members` (`findMembersByUserIds` en
`read.ts`, que busca `members/{workspaceId}_{id}` — el mismo id que
`assigneeId`/`creatorId`/`updatedBy` de un issue, sea un uid humano o un
`agentId`, gracias al member espejo que `agents.create`/
`migrate-agent-roles.mjs` siembran para cada agente).

`pulse_list_activity` lee la colección `activity` (`Activity` en
`domain.generated.ts`), que hoy ningún código del backend escribe todavía —
la tool está para cuando exista ese productor, y mientras tanto devuelve
siempre una lista vacía en vez de faltar.

Ninguna de las tools nuevas necesitó un índice compuesto nuevo en
`firestore.indexes.json`: `comments` ya tenía uno por
`workspaceId + issueId + createdAt` (`pulse_list_comments` lo reusa con
`orderBy`/rango en `createdAt`); `agent_runs` y `cycles` se filtran por un
solo campo de igualdad (`workspaceId`, y opcionalmente `issueId`/`teamId` en
memoria) y se ordenan en memoria, igual que ya hacía `pulse_list_issues` con
`status`/`type`/`labelIds`/`search`.
