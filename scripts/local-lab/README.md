# Pulse local E2E lab (TES-308)

Auth, Firestore, Functions and the TES-304 frontend run together against
`demo-pulse-local`. This is a local lab, not a deployed dev environment.
Production remains `pulse-app-93` and these commands never deploy.

## Start

Requires Node 20+, Java 21, Firebase CLI and installed dependencies in the
backend `functions`, frontend and Runner checkouts. Defaults are the sibling
TES-304 worktrees. Set `PULSE_LAB_APP` / `PULSE_LAB_RUNNER` to other checkout
paths when reusing the harness later.

From the backend checkout, in terminal 1:

```sh
node scripts/local-lab/lab.mjs start
```

Wait for Functions to load and all emulators to be ready. In terminal 2:

```sh
node scripts/local-lab/lab.mjs seed
node scripts/local-lab/lab.mjs check
node scripts/local-lab/lab.mjs web
```

Open http://127.0.0.1:3000 and log in with
`local-owner@pulse.test` / `PulseLocal123!`. Other fixture users are
`local-admin@pulse.test`, `local-other@pulse.test`, and
`local-outsider@pulse.test` (same local-only password). The outsider belongs
to a different workspace. Emulator UI: http://127.0.0.1:4000.

The `check` command uses the real backend HTTP endpoints, Firebase Auth,
Runner executable, Git checkouts, signed jobs and scoped MCP credentials.
Only the provider CLI is doubled. It checks both Codex and Claude:

- Dev/QA identity readiness; missing session and identity rejection.
- Owner and workspace isolation; unauthorized repositories and capacity.
- Signed task delivery, scoped MCP issue read, completion and key revocation.
- Structured failure with correlation and redaction, followed by retry.
- QA job transport and role validation using a local fixture PR reference.

QA transport does not validate a real GitHub diff or the provider's verdict.
The check adds terminal job history and can be repeated. Run `seed` after
every emulator restart: Firestore/Auth are intentionally ephemeral. Repeated
seeding reuses registered Runners and resets fixture agents/issues. Build
changes require restarting `start`, which copies the compiled backend into
the isolated runtime source.

## UI and multiple Runners

Keep both fixture Runners running in separate terminals to maintain fresh
readiness (otherwise preparation expires):

```sh
node scripts/local-lab/lab.mjs runner codex start
node scripts/local-lab/lab.mjs runner claude start
```

In Settings → Agents check each provider/role, effective identity, readiness,
recent jobs, phase/category/correlation and retry. Use owner/admin/other
accounts to validate controls. `autonomousMode` is disabled in fixtures and
the project is paused; manual smoke dispatch is explicit.

## Native provider sessions

To check locally installed CLIs and their existing native sessions:

```sh
node scripts/local-lab/lab.mjs runner codex diagnose --live
node scripts/local-lab/lab.mjs runner claude diagnose --live
```

`--live` removes the fake executables. It does not log in or modify native
sessions. Running `start --live` or `run --once --live` executes jobs using
those sessions and consumes provider usage. For a full native smoke, enqueue
a local fixture job from the UI, then run the relevant Runner with `--live`.
Do not use the QA fixture's fake PR as proof of a real QA verdict; full
GitHub review/publication remains a separate integration validation.

## Isolation and cleanup

Runtime files, generated signing keys, fixture MCP/device credentials, Git
remote and Runner homes are under `.emulator-data/local-lab` (gitignored;
private files mode 0600). No production secrets are loaded. Telemetry DSN is
empty and Git URLs for `pulse-local/fixture` are redirected per process to a
local bare repository. Global Git config, GitHub account, gcloud config and
ADC are unchanged. Native provider sessions stay in their original stores.
Stop each foreground process with Ctrl-C. Delete this ignored lab directory
only when discarding fixtures, then restart and seed to regenerate it.

For local tracker reads through the workspace wrapper:

```sh
PULSE_MCP_URL=http://127.0.0.1:5001/demo-pulse-local/us-east4/pulseMcp \
PULSE_MCP_TOKEN_FILE=/Users/rafaelrodriguez/Pulse/pulse-backend-tes-304-preflight/.emulator-data/local-lab/mcp-token \
/Users/rafaelrodriguez/Pulse/scripts/pulse-mcp.sh pulse_whoami
```

The wrapper requires that exact local token path when using the emulator;
its default still uses the production Test Startup tracker credential.
