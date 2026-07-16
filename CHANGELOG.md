# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Reorder workflow steps to run code quality checks before capturing intent and renaming the branch. This optimizes the fail-fast path: if checks fail, the workflow exits early without performing downstream operations.
- Renderer selection (`PIPELINE_WORKER_PLAIN_OUTPUT` vs. the live dashboard) is now a pure, independently-tested function, and the step-tree/renderer layer gained an edge-case test matrix: narrow and undefined terminal widths, resize mid-run, an unknown step id (never throws — the run keeps going), and the exact shape an escalated run leaves in the narration (the failing step and its `ci-watch` parent both marked failed, `merge` left pending).
- **Behavior change:** `PIPELINE_WORKER_AUTO_MERGE_ON_GREEN` now defaults to `true` (was `false`). A `pipeline-worker run` now goes all the way to a merged PR/MR with your local target branch fast-forwarded, unattended, instead of stopping at "CI is green, merge it yourself." This remains best-effort — a forge that rejects auto-merge (required approvals, feature disabled, ...) leaves the run to finish normally and you merge manually, exactly as before. Set `PIPELINE_WORKER_AUTO_MERGE_ON_GREEN=false` to restore the previous default. Enabling `PIPELINE_WORKER_SQUASH_ON_MERGE` alongside the new default now prints a warning at startup, since the forge may merge (and delete) the branch before the squash push runs.

### Fixed

- Added truncateToWidth() utility function to prevent spinner detail text from exceeding terminal width, preventing unwanted line wrapping. Integrated into runStep() render function to apply terminal-width-aware truncation.
- `watchPipeline` no longer polls the full 2-hour safety window before crashing when a GitLab pipeline ends in `manual` or `scheduled` status (e.g. a manual deploy gate after tests) — both are now recognized as terminal and escalate to a human immediately, same as `canceled`/`skipped`.
- Forge API calls (`forgeFetch`) now retry transient 429/5xx responses and network errors with bounded exponential backoff (honoring `Retry-After` on 429), instead of crashing the whole run on a single blip during a long CI-watch poll loop.
- CI-fix and merge-conflict-resolution now re-run build/lint/test locally before pushing, looping back to the agent on a local failure instead of spending a full remote CI round-trip to discover an obviously broken fix.
- `hasCiConfig` now checks a GitLab project's actual "CI/CD configuration file" setting (via a new `ForgeClient.getCiConfigPath`) in addition to the conventional `.gitlab-ci.yml` path, fixing a false "no CI configured" conclusion for projects using a custom path.
- This repo's own release workflow (`.github/workflows/ci.yml`): the `publish` job now serializes via a `concurrency` group and rebases before the version-bump push, fixing a race where two merges close together could fail the second one's push as non-fast-forward.

### Added

- Introduces a core diff-management module (src/git/diff.ts) that exports three functions: captureDiff for staged/unstaged changes and untracked files, changedFilesSinceRef for ref-based file queries used by adoptBranch, and resetRepo for cleanup. The orchestrate workflow is updated to import and use these functions. Tests verify diff capture accuracy with real git repos.
- Implements TreeRenderer for interactive live TTY dashboard with step-tree rendering, terminal-aware truncation, automatic height/width adaptation via step collapsing, comprehensive edge-case tests (narrow terminals, unknown steps, resize handling), and architecture documentation.
- Introduces box-drawing and text formatting utilities to format.ts, exports new structured output functions from steps.ts, and refactors the welcome banner to use a cleaner box-drawing presentation with version information
- Live TTY dashboard: on a real terminal, `pipeline-worker run`/`resume` now redraws a header line plus the step tree in place (glyphs for pending/running/done/failed/skipped, durations, best-effort tokens, `attempt N/M`) instead of scrolling a new block per stage — CI logs, piped output, and the new `PIPELINE_WORKER_PLAIN_OUTPUT=true` escape hatch keep the previous append-only narration. A long-running fix/rebase loop that outgrows the terminal height collapses its older attempts into a single `… N earlier attempts` line rather than pushing the live rows off-screen.
- Best-effort agent token accounting: every agent turn's token spend (reported today by the Claude Code CLI's JSON envelope; pi/copilot expose none, and absence is shown as unknown, never zero) is recorded into the run's persisted history and summed into a per-run total. `pipeline-worker sessions` gains a TOKENS column in the list view and per-entry/total token figures in the detail view.
- New final workflow stage (14) when `PIPELINE_WORKER_AUTO_MERGE_ON_GREEN` is enabled: after CI goes green, the run waits for the forge to confirm the MR/PR actually merged (polling a new `ForgeClient.isMrMerged`, bounded at 60s), pauses a few seconds for the target-branch ref to settle, then fast-forwards your local target branch from origin — your local main already contains the merged result when the run (or `resume`) ends. Best-effort: pending approvals, a switched-away branch, or a diverged local target branch degrade to a "run `git pull` yourself" note, never a failed run.
- Major feature release adding auto-merge-on-green with configurable strategies (merge/squash/rebase), optional squash-on-merge history cleanup, exponential-backoff retry logic for transient forge API failures, recognition of manual/scheduled as terminal pipeline statuses, local check verification after conflict resolution, and hardened release workflow with concurrency serialization and rebase-before-push. Splits state.attempt into independent ciFixAttempt and conflictAttempt budgets so long-lived PRs needing rebases don't exhaust the real-bug-fixing budget.
- Added branch adoption feature to `pipeline-worker resume --branch <name>`, allowing it to check out external branches (committed/pushed by hand) and either open a new PR/MR or refresh an existing one's description before resuming the watch loop. Includes new forge methods for updating MR descriptions, git utilities for merge-base and committed file diffs, and comprehensive workflow for both adoption paths.
- `pw` as a shorter alias for the `pipeline-worker` command (both installed by `npm install -g pipeline-worker`).
- `pipeline-worker run` now checks npm for a newer published version before starting and installs it automatically if the locally installed one is out of date. Best-effort: an unreachable registry or failed install is logged as a warning and the run proceeds on the currently installed version.
- `PIPELINE_WORKER_UPDATE_CHANGELOG` (default `false`): once checks pass, add a bullet for the change (from the captured intent's summary) under the consuming repo's `CHANGELOG.md` `[Unreleased]` section — creating the file, Keep a Changelog style, if none exists — and include it in the same commit that becomes the MR/PR.
- Language-agnostic check defaults: `build` / `lint` / `test` are auto-detected from the repo's toolchain — npm scripts (Node/TypeScript), .NET (`dotnet build/format/test`), Go (`go build/vet/test ./...`), Python (`pytest`). Explicit config always wins; an empty command skips the stage.
- `PIPELINE_WORKER_AUTO_MERGE_ON_GREEN` (default `false`) + `PIPELINE_WORKER_MERGE_METHOD` (default `squash`): once the MR/PR opens, ask the forge to merge it automatically once CI (and any required approvals) allow — best-effort, never fails the run if the forge rejects it.
- `PIPELINE_WORKER_SQUASH_ON_MERGE` (default `false`): once CI is green, collapse every commit the run made on the branch into one (titled from the captured intent) and force-push, keeping history clean regardless of the target repo's merge-strategy setting.

### Changed

- `RunState`'s single shared `attempt` counter is now two independent counters, `ciFixAttempt` and `conflictAttempt`, each bounded by `PIPELINE_WORKER_MAX_FIX_ATTEMPTS` — a long-lived PR needing several trivial rebases can no longer exhaust the budget meant for real bug-fixing. Existing persisted state files migrate automatically on load.

- This refactoring breaks down large functions into focused, well-named helpers across multiple modules: orchestrate.ts, watchPipeline.ts, lock.ts, cli.ts, and autoUpdate.ts. Additionally, common code between GitHub and GitLab forge implementations is extracted into a new shared module. A new signal cleanup utility module is introduced to handle SIGINT/SIGTERM consistently across both orchestrate and resume flows.
- Removed the shipped `.env.example` / `.pipeline-worker.yml.example` templates. Real environment variables already take precedence over both files, so exporting `PIPELINE_WORKER_*` once in your shell profile now covers global setup across every repo — see the README Quick start. Per-repo `.env` / `.pipeline-worker.yml` are still supported as optional local overrides.

## [0.1.0] - 2026-07-01

### Added

- `run` workflow: diff capture → disposable worktree → agent intent capture → build/lint/test → commit → MR/PR → pipeline watch with bounded auto-fix loop.
- Forge support: GitLab (merge requests + pipelines) and GitHub (pull requests + Actions workflow runs).
- Agent support: Claude Code and GitHub Copilot CLI, selected via config.
- `serve`: companion forge MCP server with TOON-encoded, truncation-aware tool responses.
- `resume` / `status` commands backed by per-branch persisted run state.
- Configuration via `.pipeline-worker.yml`, `.env`, and `PIPELINE_WORKER_*` environment variables, including `pollIntervalSeconds`.
