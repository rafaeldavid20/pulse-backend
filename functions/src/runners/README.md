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
Do not send the provider's full result object, logs, sessions, prompts, or
responses.
