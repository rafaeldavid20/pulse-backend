# Runner profile control protocol v1 (TES-294)

The local `agent-profiles.json` is authoritative. A Pulse request is not an
applied profile. The frontend only reports success after a device-authenticated
acknowledgement of that request ID. No development job or inbound machine port
is used to edit configuration.

## Scope and authorization

`runners.profile` is a human Platform Action with `read` and `request` operations.
Every call resolves workspace from the agent, checks workspace membership,
agent administration AND Runner administration, and verifies the active
`agent.runnerId`. Public visibility does not grant access. Direct Firestore
reads/writes of `runner_profiles` and `runner_profile_requests` are denied,
including to workspace administrators. Generic action-ID caching is disabled
for this action, so cached responses cannot bypass fresh authorization.

Each profile key includes workspace, agent and Runner. Repository scope is the
union of current workspace projects intersected with installed GitHub repos,
using `runnerProjectRepoAccess`, the strict resolver used by signed dispatch.
The local Runner further intersects this with its configured repositories and
GitHub App bindings. It cannot add a repository through a profile patch.

Changing `agent.runnerId` rotates `profileBinding`. The binding fingerprint also
includes provider, role, ownership, visibility and repository scope. Old
snapshots and requests cannot be reused after a binding change, including a
switch away and back. A new installation reads its own local profile; Pulse
never copies paths or a previous Runner's confirmation.

## Exchange

The Runner's existing outbound HTTPS transport authenticates
`pulseRunnerProfiles` with its paired device credential. Request:

```json
{"version":1,"agentIds":["agent-example"],"profiles":[]}
```

The response is `{version:1, contexts:[...]}`. Each context contains workspace,
agent, Runner, provider, role, binding, effective repos and pending commands.
Only currently bound identities are returned. Each command contains:

```text
version=1, workspaceId, agentId, runnerId, binding, provider, repos,
requestId (UUID), expectedRevision (opaque digest), expiresAt,
patch={model?: modelId|null, directories?: [{repo,candidateId|null}]}
```

The Runner publishes `{agentId,binding,snapshot,result?}` entries in `profiles`.
The snapshot allow-list is:

```text
version=1, revision, provider, model|null, modelValid, models[],
directories:[{repo,selected:null|candidateId,valid,
              candidates:[{id:candidateId,alias:"Checkout N"}]}]
```

Only CLI-discovered, syntactically safe model IDs are published. Unavailable
local overrides are marked invalid without exporting arbitrary local strings.
Aliases are ordinal labels, never path basenames. Candidate IDs are random
256-bit values scoped to one local workspace/agent profile. Absolute paths and
Git output remain local. No filesystem inventory, provider session, file
content or credential is part of the contract. Unknown fields and path-shaped
inputs fail validation before the Platform Action audit is created. Audits keep
actor, target and request ID; request documents keep safe validated metadata and
terminal result codes. Exceptions from local validation never cross the wire.

The server supplies `observedAt`, returns only the snapshot for the current
binding, and accepts a result only for an existing request on that binding.
The actor's authority is rechecked on every delivery and confirmation. Runner
also checks local identity/provider/role, workspace, Runner, binding, repo and
candidate scope; after slow validation it asks the server again before writing.
Revocation or rebinding invalidates that check.

## Atomicity, retries and timeouts

Admission requires a live Runner, v1 capability, a snapshot observed within two
minutes, and matching revision. Busy Runners may accept profile edits; their
active job already captured its own profile. New edits are not admitted offline.
One unresolved request per binding is allowed. Commands expire after one minute.

All CLI and remote profile writers take `profiles.lock`. A stale lock belonging
to a dead process is recoverable. The Runner validates the whole proposed
profile (model catalogue, accessible Git root, exact authorized GitHub origin),
checks revision again, writes settings and the request result together to a
private temporary file, fsyncs it and atomically renames it. Results are journaled
locally by request ID plus command fingerprint. The revision excludes that
journal. Replaying an identical ID returns its original result; changing its
payload is rejected. Rejecting a patch leaves the previous settings intact.

Terminal codes are `applied`, `validation_failed`, `conflict`, `expired`, and
`forbidden`. A command already committed locally is reconciled from its journal
even after expiry. The backend does not infer a failure or success from a lost
connection, snapshot equality or elapsed timeout. If a later CLI edit follows
an applied command, its current snapshot may have a different revision from
the command's original applied revision; the result still identifies the
original operation.

The UI retains confirmed values while applying, persists only safe request
metadata locally, queries uncertain IDs after reconnection and allows an
explicit retry of the same ID when admission itself was uncertain. It never
automatically enqueues an offline edit. Disconnected snapshots are historical;
conflicts require reloading the form.

## Local operations and execution

```sh
pulse-runner profile register --agent AGENT --repo owner/repo --directory LOCAL_GIT_ROOT
pulse-runner profile set --agent AGENT --repo owner/repo --directory LOCAL_GIT_ROOT
pulse-runner profile set --agent AGENT --model MODEL
pulse-runner profile remove --agent AGENT --repo owner/repo
```

`register` adds a candidate without selecting it. `set` also selects it.
Selecting an agent requires a matching locally registered identity. Removing
an override retains the candidate catalogue and idempotency journal. CLI model
validation uses Codex's read-only app-server `model/list` catalogue or Claude's
documented model aliases from the installed CLI help. If the installed CLI
cannot supply a validated catalogue, no explicit model is offered. No inference
is performed to discover models. Provider-side outages/entitlement changes can
still fail subsequent inference, as they can with the provider's default model.

Profiles are reloaded and revalidated before the next job. Every effective
repository override feeds its own isolated development worktree. Source
checkouts are never used as the job's working directory. QA continues to use
the signed snapshot/revision flow and ignores directory overrides. Active jobs
retain their captured model and directories.

## Compatibility and rollout

Deploy backend before the coordinated frontend and Runner. Heartbeat readiness
announces `profileProtocolVersion:1`; an older Runner's next readiness heartbeat
clears that capability. Older Runners still execute their local profiles and
the existing job protocols unchanged. The UI displays update required and
disables remote editing. A new Runner with an older backend tolerates a missing
profile endpoint and continues normal local execution. Upgrade/restart Runner
and run its normal local diagnose flow to publish a fresh observation.

## Verification

From backend `functions`, with the coordinated Runner checkout available:

```sh
npm test
PULSE_RUNNER_SOURCE=/path/to/coordinated/pulse-runner npm run test:profiles
npm run test:integration
npm run test:rules
```

`test:profiles` is deliberately separate from backend-only CI: it imports the
actual Runner implementation from `PULSE_RUNNER_SOURCE` (or a sibling checkout)
and fails if unavailable. It uses an isolated Firestore emulator, temporary
local profiles and simulated CLI/catalogue validation; it never accesses
production or runs inference. It covers confirmed application, loss after
local commit, duplicate IDs, atomic failure, conflict, revoked permissions,
public agents, workspace/Runner/candidate isolation, rebinding, independent
agents and concurrent submissions. Runner's full suite additionally exercises
real temporary Git repositories, CLI subprocess fixtures, worktrees,
cancellation and QA snapshots. Synthetic private paths and secrets are checked
for absence from wire payloads and persisted server data/audit.

Frontend: `node --test scripts/runner-profile.test.mjs`, `npm run lint`, and
`npx tsc --noEmit`. Production build can use `npx next build --webpack` in
sandboxes that deny Turbopack's worker port. No production pairing or live
provider entitlement/inference was exercised by these tests.
