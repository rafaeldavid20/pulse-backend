# Runner completion usage contract

`pulseRunnerComplete` accepts the existing `jobId` and `outcome` (`completed`,
`failed`, or `canceled`) plus an optional `usageReport`. The Runner authenticates
with its device credential. The server resolves the provider from the job's
agent and ignores all fields except the counters below.

Claude example:

```json
{
  "jobId": "job-id", "outcome": "completed",
  "usageReport": {
    "usage": {
      "input_tokens": 100, "output_tokens": 40,
      "cache_read_input_tokens": 20, "cache_creation_input_tokens": 10
    },
    "costUsd": 0.02
  }
}
```

Codex uses `input_tokens`, `output_tokens`, and optional
`cached_input_tokens`. Claude's `input_tokens` excludes cache categories, so
the server includes them in the stored `inputTokens`. Codex's `input_tokens`
already includes cached input. Cache fields in the response are breakdowns,
never additional totals.

Send `usageReport: { "usage": null }` or omit it when structured usage is
unavailable. Cost is optional and must come from the provider, not an estimate.
The same report format is accepted for failed and canceled jobs. A retry of a
completed job returns its original status without changing the stored usage.
Jobs for legacy agent kinds (such as `chatgpt`) still complete; the server
discards any unsupported usage report and stores `usage: null`.
Do not send the provider's full result object, logs, sessions, prompts, or
responses.

### Agent activity (TES-311)

`Issue.agentActivity` is a server-owned map keyed by run ID, with `{ role?, expiresAt }`.
Only a fresh host lease represents active execution. Dispatch, assignment, claim,
and workflow status do not create a lease. The frontend observes this map through
its existing issue subscription and expires it locally even when the host disappears.
Multiple simultaneous dev/QA runs remain independent.

The local Runner heartbeat sends `agentActive: true` only while the provider CLI
is executing; preparation, publication and recovery send `false`. The backend
checks the delivered job, cancellation and expiry, and renews a two-minute lease
at most every 30 seconds. Terminal jobs and explicit cancellation remove the badge.
Older Runners without this field safely show no active badge; upgrade the Runner
along with this backend change.

An explicit host stop is final for that run: delayed active heartbeats cannot
restart the lease. Hosts that disappear expire within two minutes. Recovery-only
publication jobs never start a model or show an activity badge. GitHub Actions
agent workflows were retired in TES-337; there is no MCP heartbeat tool or
workflow migration in this change. Absence of the map means inactive.
