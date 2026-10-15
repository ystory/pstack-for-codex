# Development and maintenance

The [design document](spec.md) describes source integrity, adaptations, and compatibility boundaries. The [README](../README.md) covers plugin installation and use.

## Development checks

Use the Node requirement and pinned package manager in [package.json](../package.json). Setup checks also require Python 3.11 or later for the standard-library TOML parser.

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

Choose a new output directory for each artifact. A build verifies its inputs and produces `plugin/`, `.agents/plugins/marketplace.json`, and `artifact.json`.

```sh
mkdir -p .local/artifacts
node dist/cli.js build-plugin --output "$PWD/.local/artifacts/example" --marketplace "$PWD/.local/artifacts"
node dist/cli.js verify-plugin --artifact "$PWD/.local/artifacts/example"
```

`--marketplace` selects the verified child artifact through a fixed physical marketplace directory. The selection changes atomically after successful verification; failures preserve the previous selection and existing artifacts. Omitting `--marketplace` creates an artifact without changing the selection. Artifacts and marketplace paths must use real directories rather than symlinks; an existing artifact cannot itself become the mutable marketplace root.

Select or restore an existing child artifact with:

```sh
node dist/cli.js promote-plugin --artifact "$PWD/.local/artifacts/ARTIFACT_NAME" --marketplace "$PWD/.local/artifacts"
```

Replace `ARTIFACT_NAME` with an existing directory name. Promotion verifies the artifact before changing the marketplace. Building, verifying, or selecting an artifact does not install it, update an installed cache, activate instructions, or establish runtime compatibility. Installation and setup are described in the [README](../README.md).

## Review an upstream update

`check-upstream` reads the public GitHub API and reports upstream changes. Candidate generation uses an explicit local `cursor/plugins` Git checkout and full commit SHA:

```sh
node dist/cli.js check-upstream
node dist/cli.js upstream-candidate --source /absolute/path/to/cursor-plugins --revision FULL_COMMIT_SHA --output "$PWD/.local/candidates/update"
```

Use a new candidate output directory. The command exports both source snapshots and locks, applies the current adaptations, and records source diffs, patch failures, unapplied patches, and distribution-policy conflicts. It leaves the current pins and marketplace selection unchanged. A candidate starts with an empty Codex tested-version list.

Review `candidate-report.json`, both source diffs, and the candidate's `plugin/` tree. Resolve adaptation conflicts in that candidate rather than editing the current source snapshots. To regenerate its patch series, use a separate new output directory:

```sh
node dist/cli.js regenerate-patches --candidate "$PWD/.local/candidates/update" --output "$PWD/.local/regenerated-patches"
```

Regeneration retains existing logical file groups, records remaining reviewed changes in a final patch, and verifies replay. It preserves the original failure and unapplied-patch report. After reviewing the output, use its generated patch series in the candidate's `patches/` directory and verify the candidate:

```sh
node dist/cli.js verify-patches --project "$PWD/.local/candidates/update"
node dist/cli.js build-plugin --project "$PWD/.local/candidates/update" --output "$PWD/.local/artifacts/update-candidate"
```

Replay equality proves reproducibility, not preservation of workflow meaning. Review behavior changes, the source policy, and applicable isolated or live runtime checks before integrating new pins. Publication and activation require authorization for those operations. Keep generated artifacts and runtime receipts under ignored `.local/` storage.
