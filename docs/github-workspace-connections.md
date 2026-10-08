# GitHub connections across workspaces (TES-280)

One GitHub App installation can serve several Pulse workspaces. Each workspace selects its repositories in Settings → GitHub. A repository is assigned to one workspace at a time; this keeps webhook routing and the repository's Actions secrets/workflows unambiguous.

An admin/owner can reuse an installation already connected in another workspace they administer. Membership alone does not expose reusable installations or permit linking them. Both target and source roles are verified in the write transaction. A workspace still uses one GitHub account; this change does not add multiple accounts per workspace.

## Storage and compatibility

`github_installations/{installationId}` remains the canonical installation/token-cache document. It also retains its original workspace binding for compatibility. `availableRepositories` contains live GitHub grants; `selectedRepositoryFullNames`, `repositoryFullNames` and `repositories` on this document refer only to its original workspace. Additional bindings use `{installationId}_{workspaceId}` and contain no token cache. Existing workspace queries therefore continue to return scoped access without copying tokens.

Legacy bindings acquire an explicit selection equal to their last stored repository list during their first sync/share. New GitHub grants appear as available choices, and do not widen any workspace selection automatically. Effective repositories are the intersection of selection and GitHub access. Suspensions/uninstallations clear effective access across all bindings; unsuspension restores only selected repositories still granted by GitHub.

Selection changes are transactional. Concurrent claims for the same repo cannot succeed in two workspaces. Empty selections deny all repo access. Removing a selected repo with connected agents or Salesforce environments requires disconnecting those integrations first. Projects/issues may still reference a removed repo, but new jobs/branch operations must pass the current workspace grant. Installation revocation does not cancel jobs that are already running.

Setup callbacks never transfer an existing installation. First installations begin with no selected repos. After uninstall/reinstall, a workspace can reuse the replacement installation; the old canonical doc is preserved without its workspace binding. Token caches remain on their own canonical IDs.

## Rollout and validation

Deploy backend before frontend. No bulk production migration is required. On first sync, verify the retained selections for existing workspaces; if GitHub access changed previously, review each workspace's choices explicitly.

In RosmerClass, choose the reusable account, authorize missing repositories in GitHub if needed, return to Pulse, update the list, select RosmerClass repos and save. Verify Test Startup retains its own repos and that branch/PR events reach only the intended workspace. This production/browser check is pending; tests do not prove that the GitHub setup redirect occurs when editing an existing installation. The reuse action does not require that redirect.

Validation: 50 unit tests; 73 integration tests with a separate Firestore emulator and mocked GitHub (11 TES-280 scenarios); backend TypeScript build; frontend production build, TypeScript check and ESLint for changed files. Tests cover legacy preservation, source/target permissions, concurrent repo claims, empty grants, unauthorized branch/job access, revocation/unsuspend, webhook routing, secret-free responses, setup and reinstall.
