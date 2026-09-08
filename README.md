# pulse-backend

Firebase Cloud Functions y Security Rules para Pulse — Platform Actions Engine.

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
