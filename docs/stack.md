# Development and maintenance

The [design document](spec.md) describes source integrity, adaptations, and compatibility boundaries. The [README](../README.md) covers plugin installation and use.

## Development checks

Maintainers need Node.js 24.12+, Corepack with the pnpm version pinned in [package.json](../package.json), and Git. Setup checks also require Python 3.11 or later for the standard-library TOML parser. Consumers installing the committed plugin from GitHub do not need Corepack, pnpm, or a build.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm verify
```

`verify` checks formatting, TypeScript, tests, the JavaScript build, independent packaging, source integrity, and patch replay. After dependencies are installed, these checks run offline. The package test preserves nested `.gitignore` files in a tar archive and exercises the built CLI and setup in temporary consumer directories without changing the active user profile. Live Codex/Claude runs and native plugin installation are separate checks.

Use affected checks while iterating. Documentation-only changes need formatting and link checks; distribution changes need source, patch, and artifact verification. Run the full `verify` pipeline before preparing a release artifact. Read [package.json](../package.json) for individual check scripts and run `node dist/cli.js --help` for maintainer CLI options.

The code is a single ESM TypeScript package with no Node runtime dependencies. `src/cli.ts` handles commands, `src/upstream/` handles source contracts and candidates, and `src/distribution/` handles policy, patches, artifacts, and marketplace selection. TypeScript emits the distributable JavaScript; `node:test` and Prettier provide tests and formatting. The formatting configuration excludes imported `upstream/` and `plugin/` content.

## Record an adaptation

Implement changes in `plugin/`, preserving the locked source snapshots. Describe the upstream behavior and the intended difference for review. Record the change in a new patch:

```sh
node dist/cli.js generate-patch --name NNNN-next-adaptation.patch --paths skills/SKILL_SLUG
node dist/cli.js verify-patches
```

Replace `NNNN` with the next unused four-digit series number. `--paths` accepts comma-separated files or directories relative to `plugin/`; omitting it includes all unrecorded changes. Existing patches are not overwritten. Replay applies the ordered series to a temporary copy of the combined upstream baseline and must reproduce every plugin byte, file type, and permission.

## Build and select an artifact

Build the maintainer CLI before using the artifact commands:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Choose a new output directory for each artifact. A build verifies its inputs and produces `plugin/`, `.agents/plugins/marketplace.json`, and `artifact.json`.

```sh
mkdir -p .local/artifacts
node dist/cli.js build-plugin --output "$PWD/.local/artifacts/example"
node dist/cli.js verify-plugin --artifact "$PWD/.local/artifacts/example"
```

`--marketplace` selects the verified child artifact through a fixed physical marketplace directory. The selection changes atomically after successful verification; failures preserve the previous selection and existing artifacts. Omitting `--marketplace` creates an artifact without changing the selection. Artifacts and marketplace paths must use real directories rather than symlinks; an existing artifact cannot itself become the mutable marketplace root.

Select or restore an existing child artifact with:

```sh
node dist/cli.js promote-plugin --artifact "$PWD/.local/artifacts/ARTIFACT_NAME" --marketplace "$PWD/.local/artifacts"
```

Replace `ARTIFACT_NAME` with an existing directory name. Promotion verifies the artifact before changing the marketplace. Building, verifying, or selecting an artifact does not install it, update an installed cache, activate instructions, or establish runtime compatibility.

To install a selected local artifact, add the fixed local marketplace and install its plugin:

```sh
codex plugin marketplace add "$PWD/.local/artifacts"
codex plugin add pstack-for-codex@pstack-for-codex
```

After building or promoting another artifact, repeat `codex plugin add pstack-for-codex@pstack-for-codex`, then rerun setup. For the GitHub installation route and setup, see the [README](../README.md). Both routes use the same marketplace identity; use the route you intend to maintain.

## Review an upstream update

Keep candidates, artifacts, and verification receipts in ignored `.local/` storage. Follow these steps for each update.

1. Inspect `git status`, both source locks, [distribution-policy.json](../distribution-policy.json), [patches/series](../patches/series), and [the design document](spec.md). Preserve unrelated worktree changes throughout the update. Use the checked-out repository to establish current state.

2. Build the current maintainer CLI as described in [Build and select an artifact](#build-and-select-an-artifact). Resolve the intended target in a real `cursor/plugins` Git checkout with the expected origin. `check-upstream` reports public GitHub revisions but does not fetch that checkout. Resolve the full target commit and inspect the last commits for both source paths:

   ```sh
   node dist/cli.js check-upstream
   git -C /absolute/path/to/cursor-plugins rev-parse 'TARGET_REF^{commit}'
   git -C /absolute/path/to/cursor-plugins log -1 --format=%H FULL_COMMIT_SHA -- pstack
   git -C /absolute/path/to/cursor-plugins log -1 --format=%H FULL_COMMIT_SHA -- cursor-team-kit
   ```

   Replace `TARGET_REF` with the intended ref and `FULL_COMMIT_SHA` with its resolved 40-character SHA. The lock's `revision` identifies the selected source commit. Each `pathRevision` identifies the last commit affecting its source path.

3. Create a candidate in a new output directory:

   ```sh
   node dist/cli.js upstream-candidate --source /absolute/path/to/cursor-plugins --revision FULL_COMMIT_SHA --output "$PWD/.local/candidates/update"
   ```

   The command exports both source snapshots and locks, applies the current adaptations, and records source diffs, patch failures, unapplied patches, and policy conflicts. Current pins and marketplace selection stay unchanged. Confirm the candidate locks match the selected commit and path revisions. A candidate starts with an empty Codex tested-version list.

4. Read `candidate-report.json`, both complete source diffs, and the candidate's actual `plugin/` tree. Separate upstream changes, mechanical refreshes of existing host mappings, and proposed new behavior-changing deviations. Apply the approval policy in [AGENTS.md](../AGENTS.md) before introducing a new deviation. Preserve source skill bodies except where approved host mappings require changes.

   Review the full skill inventory and descriptions. Check every new skill's frontmatter and Codex invocation metadata, links, namespaces, and mapped paths. Confirm that model routing, executors, agents, distribution-policy exclusions, and attribution still match the documented adaptations.

5. Resolve adaptation conflicts inside the candidate. Preserve the original failure reports and receipts. Refresh patches only in this reviewed candidate, keeping their order, logical ownership, and unaffected bytes. If you use the regeneration helper, choose a new output directory:

   ```sh
   node dist/cli.js regenerate-patches --candidate "$PWD/.local/candidates/update" --output "$PWD/.local/regenerated-patches"
   ```

   Read `regeneration-report.json` and every changed patch before copying the generated series into the candidate's `patches/`. The helper groups changes by existing patch paths and can add a final remainder patch. Shared paths do not justify moving a later adaptation into an earlier patch.

6. Verify the candidate's source policy and integrity, then verify patch replay and a fresh artifact:

   ```sh
   node dist/cli.js verify-patches --project "$PWD/.local/candidates/update"
   node dist/cli.js build-plugin --project "$PWD/.local/candidates/update" --output "$PWD/.local/artifacts/update-candidate"
   node dist/cli.js verify-plugin --artifact "$PWD/.local/artifacts/update-candidate"
   ```

   Require equality of actual bytes, file types, and permissions. An applied-patch count alone proves neither equality nor preservation of workflow meaning. Run applicable isolated or live workflow checks and record their scope separately.

7. Integrate the reviewed snapshots, locks, `plugin/`, and patch series as one coherent change. Copy reviewed exports rather than editing locked snapshots by hand. Run `corepack pnpm verify` after integration, then build and verify a fresh artifact from the repository. Omit `--marketplace` when verifying an artifact. For later changes confined to maintainer documentation, use the formatting and link checks described in [Development checks](#development-checks).

8. Report the source version and target SHA, semantic differences, patch changes, and automated checks. State which live workflows ran or remain untested. Report artifact verification, marketplace selection, installation, and activation separately. Preserve the configured Git identity and signing settings when committing. Promote or install only within the authorized scope. Existing authorization covers its routine steps without another approval.
