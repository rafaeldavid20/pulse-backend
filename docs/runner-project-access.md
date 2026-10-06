# Runner repository access (TES-298)

Projects explicitly enable repositories in `repoFullNames`. New Runner jobs intersect that list with the workspace GitHub installation; agent and device allowlists are deprecated. A project with no enabled repositories blocks dispatch and shows an actionable issue diagnostic. Configure the project instead of widening the device credential.

The backend reads issue, project, installation, agent and Runner inside enqueue/delivery transactions. Removing a repository, moving the issue or revoking the agent binding prevents delivery and does not issue an ephemeral MCP key. QA context is additionally restricted to the issue's PR repositories.

## Rollout

1. Merge/publish Runner, then update existing instances with `pulse-runner service stop`, `npm install -g @pulsehub/runner@latest`, `pulse-runner service install`, and `pulse-runner diagnose`.
2. Preserve the data directory, credential and `runner-job-v1` public key configuration. Re-pairing and `repo add` are unnecessary.
3. Deploy app/backend. New jobs use signed `protocolVersion: 2` and `projectId`, keeping the existing Ed25519 key and key ID. Readiness must report `jobProtocolVersion: 2`; older Runners are blocked before enqueue with upgrade instructions.
4. Queued legacy envelopes retain their exact payload/signature and local allowlist validation. Current project permissions are rechecked before delivery. The legacy configure endpoint only maintains/reduces its previously approved scope and cannot grant access for new jobs.

This release does not provide GitHub Actions QA credentials for other private repositories (TES-318). Full live model and workflow verification follows TES-217; fixture tests cover local execution and the emulator covers authorization transactions.
