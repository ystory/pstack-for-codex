# Global model choices

`scripts/models.mjs` stores user choices outside the plugin at `$CODEX_HOME/pstack-for-codex/models.json` (default `~/.codex/pstack-for-codex/models.json`). Resolve the script from the actual installed skill path. An explicit `--codex-home ABSOLUTE_PATH` selects an isolated destination without changing environment variables.

```json
{
  "schemaVersion": 2,
  "budget": "large",
  "roles": {
    "feature, refactoring": [
      { "model": "gpt-6.1-sol", "reasoningEffort": "xhigh" }
    ],
    "arena runners": [
      { "model": "gpt-6.1-sol", "reasoningEffort": "xhigh" },
      {
        "executor": "claude-code",
        "model": "claude-opus-5-5",
        "reasoningEffort": "xhigh"
      }
    ]
  }
}
```

The saved file contains all 17 active roles. The helper fills missing roles with the packaged defaults and reports retired roles before dropping them on a requested save. A write may supply only changed roles; omitted roles preserve existing user choices. Each role is an ordered array. The 13 scalar roles contain exactly one entry; the four original list roles contain one or more entries. The four original multi-entry defaults stay length two; configured lists retain their actual length, order, and duplicates.

`executor` is optional: omitted or `"codex"` selects the native Codex route, and `"claude-code"` selects the shared Claude CLI runner. Existing untagged entries stay native. The external route accepts the pinned model `claude-opus-5-5`, with separate `reasoningEffort`; a moving `opus` alias is not a replacement. An alias entry is `{ "model": "auto" }` or `{ "model": "inherit-parent" }`, without `reasoningEffort` and with no external executor. Both aliases select the literal Codex parent settings.

The helper reads legacy native schema 1 and mixed schema 2. It emits schema 2 whenever the resolved configuration contains a Claude executor, and schema 1 when every entry is native or a parent alias. An explicitly external entry labeled schema 1 is rejected unchanged. Older native-only bundles reject schema 2 before dispatch rather than silently discard its executor. Preferences remain on disk across rollback. To prepare a native-only configuration for an older bundle, explicitly select native models or parent aliases using the current setup and save; the resulting schema 1 retains those chosen values. No model substitution occurs automatically.

Fresh defaults are twelve Sol scalar roles, one Claude Opus `hardest tasks` scalar, and four ordered `[Sol, Opus]` lists. Saved values are never automatically migrated to those defaults. The budget ladder remains `unlimited: max`, `large: xhigh`, `medium: high`, and `small: medium`; the helper selects a supported effort at or below that target within the same executor and model. Claude capabilities use `low`, `medium`, `high`, `xhigh`, and `max`.

## Commands

- `read [--codex-home ABS]` returns `file`, `exists`, `sha256`, `config`, `targetReasoningEffort`, `droppedRoles`, and `defaultChanges`. Each proposed default change contains `role`, `current`, `proposed`, and `matchesPreviousDefault`. That exact comparison with the old all-Sol defaults does not authorize replacing a saved choice. Read never writes.
- `resolve --role "ROLE" [--codex-home ABS]` returns `role`, `entries`, `source`, `file`, `budget`, and `targetReasoningEffort`. Use one subagent per entry for panel roles. The judge pool remains a selection pool.
- `catalog --input ABS [--claude-runtime ABS]` normalizes native Codex `model/list` results or confirmed tool choices to `{ "models": [{ "model": "ID", "supportedReasoningEfforts": ["high", "xhigh"] }] }`. Collect paginated catalog results before passing them here. The optional runtime file is the shared Claude runner's `detect` JSON receipt; it adds a Claude model entry with `executor: "claude-code"` and retains the receipt under `runtimes`. The receipt needs an absolute executable, CLI version at least `2.1.280`, required print/model/effort/output-format/verbose/resume options, exact pinned model effort metadata, and a separate `modelExecutionVerified` boolean. CLI metadata is not model execution proof.
- `budget --budget unlimited|large|medium|small --catalog ABS [--codex-home ABS]` previews a full config while preserving role model choices, lists, and aliases. `needsChoice` lists entries without a confirmed effort at or below the target. This command never writes.
- `write --input ABS --catalog ABS --expected-hash HASH|absent [--codex-home ABS] [--dry-run]` validates then saves a config or a `budget` command's proposal. Use the hash from the read that informed the confirmed choices. A stale hash, malformed preference, unconfirmed model, or unsupported effort prevents writing. Dry run validates the full proposal without creating a destination.

Budget and write accept the normalized combined catalog, or native `--catalog ABS` plus `--claude-runtime ABS`. Catalog validation keys each model by executor and ID. External entries require matching runtime capabilities; a native model entry with the same ID does not validate them. The helper does not install or authenticate Claude or change its configuration.

## Invocation precedence

The saved model entry overrides a consuming skill's default model. `reasoningEffort` is that role's resolved default under the selected global budget. A skill's explicit task-specific effort remains a deliberate override; validate it against the selected executor's supported efforts. Do not append an effort to a model ID. Follow the shared [execution binding](../../poteto-mode/references/codex-execution.md) for the selected route. Claude entries use the shared runner with the pinned model and effort, task/role instructions, and absolute installed skill paths. They do not use Codex agent TOMLs or require another Claude plugin installation.

For native entries, both aliases select the literal parent model and effort and remain unchanged when the budget changes. Native `[agents]` defaults can replace omitted settings: omit override fields only when true parent inheritance has been established, otherwise bind the observed parent model and effort explicitly. If those values or that binding cannot be established, report the unresolved selection before dispatching. Use the setup-managed, description-only `pstack-general-purpose` role for generic delegates so named role defaults do not override the selected settings; keep the original two file-based agents for their designated workflows.

Native subagent tool names and argument names vary by Codex version. Bind the resolved values to the fields actually exposed in the current session; in the native spawn interface these are `model` and `reasoning_effort`. A full-history fork inherits the parent model; use a fresh-context task when the native tool requires it for explicit overrides and pass the needed evidence and absolute installed skill paths in that task.

Budget affects default reasoning. Keep the original different-model and different-family review rules in the consuming workflow when assessing results.
