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
  `DAILY_DISPATCH_LIMIT = 5` en `agent-dispatch.ts`): tope de dispatches por
  workspace por día, sin importar cuántos agentes autónomos tenga.

## Notificaciones (F1)

`issueNotificationsTrigger` (`functions/src/triggers/notify-on-issue-write.ts`,
un `onDocumentWritten` sobre `issues/{issueId}`) genera notificaciones
`assigned` y `status_change`; `comments.create`
(`functions/src/actions/comments/create-comment.ts`) genera `comment`,
`review_result` (cuando el autor es un agente `role: 'qa'`) y `mentioned`
(parseo best-effort de `@algo` contra `userId`/`displayName`/email de los
miembros del workspace — no hay todavía un picker de menciones en el
frontend). `due_soon` es del modelo pero su generación es de F5.

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
  propio trabajo es la mitad del valor del diseño. La verificación central de
  scopes por tool (`reviews:read`/`reviews:write`) es D11/TES-207, todavía sin
  hacer; esta validación puntual no depende de eso.
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
