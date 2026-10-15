# Design and compatibility

## Purpose

pstack-for-codex distributes pstack skills and agents as one versioned Codex plugin while retaining a reproducible relationship to the upstream sources. Users install through a native Codex marketplace and run setup to register agents and select models. Development and artifact commands are documented in [Maintenance](stack.md); installation and usage are in the [README](../README.md).

## Sources and reproducibility

- [upstream.lock.json](../upstream.lock.json) pins the complete pstack snapshot and the Codex source revision used for inspection.
- [dependencies.lock.json](../dependencies.lock.json) pins the selected cursor-team-kit skills (`control-ui`, `control-cli`, and `deslop`) and their license.
- [distribution-policy.json](../distribution-policy.json) excludes Benny Slack reporting automation from the distribution. The reference snapshot remains intact; general Slack research is retained. New Benny entry points or references require review rather than silent reintroduction.
- [patches/series](../patches/series) orders the Codex adaptations. The patch baseline combines the policy-filtered pstack snapshot with the selected cursor-team-kit source files, so new upstream content is applied before the adaptations.

Source snapshots are reference material, not instructions for agents working on this repository. Adaptations live in `plugin/` and retain upstream attribution and licenses. Source lock hashes cover sorted relative paths and file bytes; patch replay and artifact verification additionally compare file types and permissions. Symlinks are rejected.

A generated artifact contains the entire `plugin/` tree, native marketplace metadata, and `artifact.json` with source, patch, integrity, and recorded compatibility metadata. A fixed local marketplace can select a verified child artifact without rewriting older artifacts. Selection, installation into Codex's cache, setup, and runtime execution are separate operations.

## Codex adaptations

### Invocation and agents

The distribution preserves the upstream skill structure and explicit-invocation policy. `agents/openai.yaml` maps upstream `disable-model-invocation` declarations to Codex invocation metadata while retaining the original frontmatter. The technical names of `poteto-mode` and `make-bot-ui` use their directory slugs for callable tokens; their upstream display names remain in interface metadata.

The two upstream agent instruction bodies are also supplied as native TOML definitions. Setup registers them and a description-only `pstack-general-purpose` role. The latter carries requested model and reasoning choices without replacing the user's existing default role or adding another instruction body.

### Execution and model selection

The original 17 role keys and scalar/list shapes are preserved. Default ordinary roles use Sol 6.1 through Codex native agents; the hardest-work role uses Opus 5.5 through an existing authenticated Claude Code CLI. Candidate and reviewer lists and the cross-judge pool contain both models. Each panel entry produces an execution; a cross-judge is selected from its pool as upstream specifies.

Saved role choices override defaults. Model IDs, reasoning efforts, and executors are separate fields. `auto` and `inherit-parent` mean the current parent's actual selection. Requirements for a different model or model family remain requirements; another execution of the same model does not satisfy them.

Upstream cloud-first workers are adapted to local worktree execution. The parent passes the task, selected instructions, and required context paths to the chosen executor. This does not provide a read-only enforcement boundary or imply that an external Claude process inherits the parent's complete conversation. Managed worktrees use the host's attachment and archive lifecycle; recurring automation records its concrete local repository before scheduling.

### Setup and ownership

Setup stores role preferences under `$CODEX_HOME/pstack-for-codex/`, defaulting to `~/.codex/pstack-for-codex/`. Registration manages only its owned agent files and exact native configuration blocks. It preserves unrelated settings, comments, permissions, and role choices, and stops on user edits, conflicting declarations, symlinks, damaged ownership records, or concurrent changes. It reuses an existing Claude CLI and authentication without installing tools or changing global Claude settings.

Preferences containing a Claude executor use schema 2. Native-only preferences use schema 1. Older native-only helpers reject schema 2 rather than discarding its executor. Before restoring such a bundle, explicitly save Codex-only role choices with the current setup.

Updates and prior-version restores require installing the selected bundle and rerunning its setup. Before plugin removal, setup must unregister its owned agents while the bundle is still available; native plugin removal does not invoke an agent-cleanup hook. Model preferences are retained.

## Verified scope

Verification has several layers: source inspection, automated fixtures, live execution, and release approval. Passing one layer does not establish the others. `codex.testedVersions` records binaries used for particular checks rather than promising every workflow on those versions.

Automated checks cover source integrity, patch replay, artifact bytes and permissions, independent packaged CLI execution, isolated setup lifecycle and ownership, model preference schemas, and executor contracts. Package checks use temporary consumer directories and Codex homes. They do not establish live model access or complete native installation behavior.

The following runtime checks were performed through 2026-10-15. Some checks used earlier bundle revisions; they are evidence for the named paths rather than a complete test of every final workflow.

| Runtime                          | Executed scope                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI 0.160.0                | Native local marketplace discovery and installed/enabled metadata lookup.                                                                                                                                                                                                 |
| Codex app CLI 0.162.0-alpha.17.2 | Model and skill discovery, the 57-skill catalog and invocation metadata, bundled native agent calls, a simple `how` task, and a mixed native/Claude `interrogate` review. Setup registration, update, restore, and removal were also checked with isolated configuration. |
| Codex desktop, fresh chat        | `pstack-general-purpose`, `poteto-agent`, and `comment-sicko` were discovered and completed native role requests for Sol 6.1 with `xhigh` and `fork_turns: none`.                                                                                                         |
| Claude Code 2.1.287              | An Opus 5.5 development runner completed review, exact-session resume, and a targeted edit/test fixture; an earlier packaged bundle completed the Claude side of a mixed review.                                                                                          |
| Claude Code 2.1.300              | The installed runner completed a synthetic Opus 5.5 read-and-report task using explicit instructions, a selected skill, and an actual tool read of external reference data. The collected final result matched the data; the fixture and bundle were unchanged.           |

Claude runs confirmed the requested and observed Opus model. The exact effective Claude reasoning effort was not exposed, so an `xhigh` request is not evidence of its effective effort. The fresh native role check establishes discovery and completion for those requests, not every playbook or model configuration.

The first setup invocation through app UI onboarding, native cache version update/restore/removal, actual recurring automation and PR merging, and end-to-end execution of every playbook remain unverified. These records do not establish compatibility across platforms or accounts.
