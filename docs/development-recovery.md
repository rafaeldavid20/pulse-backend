# Manual development recovery (TES-355)

The issue detail always exposes a Development section. It uses two authenticated
platform actions; it never writes dispatch or claim fields from the browser.

- `issues.developmentStatus { issueId }` returns server-derived `state`
  (`idle`, `queued`, `running`, `failed`, `completed`), `active`, `available`,
  `mode`, and, when present, `jobId` and a corrective `reason`.
- `issues.requestDevelopment { issueId, requestId }` returns a job receipt.
  The browser retains an unacknowledged UUID in local storage across network
  errors/reloads. An acknowledged request is cleared; the next explicit attempt
  gets a new UUID. A previously accepted UUID always returns its existing job,
  even after failure, expiry or issue closure, without starting another run.
- `reviews.requestRework` remains compatible with existing MCP clients. Human
  recovery may replace a historical rework mark; automatic dispatch still uses
  its per-review-attempt guard and autonomous-mode policy.

With `changes_requested`, the job is `rework` for the current review attempt.
Its signed scope consists of all existing open/draft PR repositories, with their
existing branches. Findings, review history, PR references, human responsibility,
executor, QA mode and budgets are preserved. Changing an assigned executor during
rework is disabled in the UI. Initial recovery without review or existing PRs
queues a `task`, including for an enabled agent with autonomous mode disabled.
Other review states use the existing QA/escalation controls.

Enqueue rechecks human membership/ownership or public-agent admin permission,
agent/Runner binding and preparation, current project/GitHub repository access,
review limit, issue run/cost budget, workspace pause/daily budget, and agent/Runner
capacity inside the transaction. The availability preview is advisory.

A claim timestamp never proves liveness. The transaction checks all jobs for the
issue (including other Runners and QA), the issue activity map, and run leases.
Unexpired pending/delivered jobs or fresh host leases block replacement. Unknown
job expiry blocks conservatively. Only after all checks/signing succeed does the
transaction expire obsolete jobs, clear residual claim fields, write the new job,
consume budget, and record the request receipt and run. The recovered claim is
retained in the receipt. No active job is released merely because a claim is old.
Failed/preflight requests retain their result in `platform_actions`; accepted
requests additionally have immutable `development_requests` receipts and
`agent_runs`. Retrying with a new UUID does not erase the earlier job or its result.

The UI polls the server every ten seconds and reconciles immediately after a
request. It calls an in-flight HTTP request “solicitando”; only server job/lease
evidence renders “en cola” or “en ejecución”. Diagnostics link to Agent settings,
where job IDs, Runner state and budgets can be inspected. Done/canceled issues
require explicit reopening; these actions never reset budgets or change QA mode.

## Regression commands

From `pulse-app`: `npm test`, `npx tsc --noEmit`, `npm run lint`.
The UI tests cover double clicks, unconfirmed requests, reload, failed-job recovery,
historic QA marks, live execution and server blocking reasons.

From `pulse-backend/functions`: `npm test`.
From `pulse-backend`:

```sh
firebase emulators:exec --project demo-pulse-local --only firestore \
  'node --test functions/lib/integration/human-rework.test.js'
```

Integration fixtures cover TES-294-style multi-repo rework with residual claims,
manual agents, same/different concurrent request IDs, expiry, job/lease liveness,
permissions, offline/preflight recovery, budgets, capacities and transactional
revocation after a ready preview. They use generated in-memory signing keys and
local Firestore; no provider inference or production data is required.

Deploy the backend actions together with the frontend control. Verification here
is automated and local; it does not modify TES-294 or execute its findings.

## Local verification evidence

- Frontend: 8 UI tests passed; TypeScript and ESLint passed. The domain sync
  script assumes sibling repositories named `pulse-app`/`pulse-backend`, so its
  automatic check skips the Runner's prefixed paths. An explicit byte comparison
  against `headerFor(hashOf(source)) + source` confirmed the actual worktrees match.
- Backend: build and all 72 unit tests passed.
- Firestore emulator: all 48 tests in `human-rework.test.js` and
  `manual-qa.test.js` passed with `--test-concurrency=1` (including 32 development/
  rework tests and 16 QA tests).
- Broader suite diagnostic: parallel execution passed 232/233, with one QA test
  returning emulator `Transaction is invalid or closed`. The serial run passed
  that QA test and 216 tests total, then stalled in the unrelated workspace
  rename snapshot listener and was stopped. The final focused run above passed
  cleanly. This is not a claim that the entire integration suite passed.
