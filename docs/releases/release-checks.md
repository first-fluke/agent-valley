# Release checks

Release-please updates the root, CLI, core, dashboard, and public plugin versions together. Public plugin JSON uses multiline arrays and objects to match the release updater's formatting. CLI help, MCP initialization, and the capture MCP client read installed package metadata. Run `node scripts/check-release-versions.mjs` before publishing; CI rejects inconsistent versions or missing release updates.

The source CLI manifest contains workspace dependencies for development. Publish the staged distribution at `apps/cli/dist/npm`. Its Node bundles include runtime dependencies, skills, plugin metadata, and the AGPL license. The distribution manifest has no install hooks or workspace dependencies and declares the Node/Bun runtime requirements.

After authorizing a CLI build, run:

```bash
bun run --cwd apps/cli build
node scripts/verify-cli-package.mjs apps/cli/dist/npm
```

The second command creates a local npm tarball, installs it offline in a temporary consumer outside the monorepo, and runs the Node CLI and executable link. It checks Kimi TOML discovery, unattended setup, exported plugin metadata and licenses, and MCP initialization, tools, and read-only mission listing. It also resumes a paused checkpoint through the installed Node supervisor and direct execution, checking exit code, state and budget preservation, and lock cleanup. Native fixtures use a temporary home and Git repository; provider commands are replaced with rejecting fixtures, and no model task or provider account is used. CI runs this check on changes to main and release publishing repeats it from the exact release tag.

Also run the repository type, lint, test, coverage, and harness checks. Installer tests cover preserving existing OMA configuration, conflicting files, and selecting/updating release refs. Mission subprocess tests cover successful, failed, paused, waiting, and interrupted orders with fixture native sessions.

Strict `--oma` receipts have a separate supported CLI version and native contract suite; see [OMA completion evidence](../guides/oma-integration.md). CI installs that exact version before coverage so its native receipt tests run. For local checks, record whether those tests actually ran rather than treating skips as passes. Provider fixture tests do not establish a live account's authentication or current CLI compatibility. Record a small real mission and resume result for the vendors/platforms claimed in release notes. Public web MCP and external reporting channels need their configured service credentials for live validation.

For reproducible source installation, use a release containing ref selection: download its `scripts/install.sh` from the published tag and pass that same `--ref vX.Y.Z`. The default remains `main` for development. Existing OMA configuration is preserved and updated through OMA preparation.

Every push to `main` runs the release workflow. Release-please creates or refreshes its release PR, then the workflow runs the full reusable CI suite against that PR's exact commit. After CI passes, it checks that both the PR and `main` still match the commits it validated, squash-merges the PR, creates the GitHub release and tag, and publishes the verified npm package from that tag. Only the repository's release-please bot PR with the pending-release label can be merged this way. Other PRs use the normal review process.

PR verification, merge, and tagging run in one **Release** workflow because pushes made with `GITHUB_TOKEN` do not start another workflow. It dispatches **Publish npm** at the exact release tag; that separate run records the actual tagged build commit in npm provenance. Release runs are serialized. If a newer push or PR edit makes the verified commits stale, the merge stops; the next release run refreshes and checks the new candidate. The merged Git tree must match the tested PR, and main must still point to that merge before tagging. Release-please's `always-update` option refreshes the PR even when a main change does not appear in the changelog.

Use the **Release** workflow's **Run workflow** button on `main` to retry a stopped merge or recover a merged release that has not been tagged yet. When no release PR is open, the workflow validates its main commit before checking for a release to tag. For an npm publish failure after tagging, rerun the failed job in **Publish npm**, or dispatch that workflow at the release tag. Publishing uses the repository's `NPM_TOKEN` secret. GitHub branch protection still applies to the merge API.
