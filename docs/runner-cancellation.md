# Runner cancellation and repository scope (TES-286)

`runners.cancelJob` is a human-authenticated platform action. Its transaction checks workspace membership and Runner owner/admin permissions, records `cancelRequestedAt`/`cancelRequestedBy`, and revokes job MCP keys. Pending jobs become terminal `canceled`; delivered jobs remain active until the Runner acknowledges local cleanup. Repeated requests retain the original requester/timestamp; terminal jobs remain unchanged.

An authenticated `pulseRunnerHeartbeat` can carry `jobId`. The job must belong to that Runner and workspace. The response includes `cancelRequested` for requested, expired or non-delivered jobs. Runner polls this while its provider CLI is running. A revoked device receives 401 and must stop locally. Network failures also stop execution; an acknowledgment may require reconnect/restart or the existing expiry sweeper.

`recordRunnerCompletion` resolves completion/cancellation races transactionally: a delivered job with `cancelRequestedAt` always finishes `canceled`, including its `agent_runs.runnerOutcome`. The endpoint reads the stored outcome before attempting a successful handoff. The Runner reports completion after its cleanup, so active capacity remains occupied until local resources are released.

`pulseRunnerConfigure` accepts only subsets of the current owner-approved repository list, under a Firestore transaction, and checks revocation again. Expansion requires an owner/admin-approved replacement registration through Settings; local rejection must not save a widened configuration. Existing Settings registration is the human approval boundary.

## Rollout

Upgrade Runner first, then deploy backend and frontend together. Older Runners cannot stop an active CLI in response to a cancellation. Backend deployment requires `RUNNER_JOB_SIGNING_PRIVATE_KEY` to exist already and match the public key/key ID shipped by Runner. Current signing is Ed25519 with explicit `contextRepos`; historical HMAC pending jobs cannot be translated locally. For any future format/key change, drain/cancel pending jobs before rollout and rotate the public key on each Runner; current TTL is 30 minutes. No private signing key or provider session belongs in Git, logs or the frontend.

## Verification

`npm test` in `functions/` builds and runs unit tests. `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test functions/lib/integration/*.test.js` runs integration tests only against the local emulator (initialize project `pulse-integration`); it must never target production. `runner-cancellation.test.ts` covers owner/admin/member/external-workspace permissions, pending and delivered cancellation, scoped heartbeat, MCP revocation, completion races, idempotency and actual configure/complete/heartbeat handlers. Runner has separate fixture CLI/Git/process-tree integration tests.

These checks do not validate deployed UI, live provider jobs or actual service installation on all operating systems. Those remain explicit rollout validation limits.
