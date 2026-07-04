# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `pw` as a shorter alias for the `pipeline-worker` command (both installed by `npm install -g pipeline-worker`).
- `pipeline-worker run` now checks npm for a newer published version before starting and installs it automatically if the locally installed one is out of date. Best-effort: an unreachable registry or failed install is logged as a warning and the run proceeds on the currently installed version.
- `PIPELINE_WORKER_UPDATE_CHANGELOG` (default `false`): once checks pass, add a bullet for the change (from the captured intent's summary) under the consuming repo's `CHANGELOG.md` `[Unreleased]` section — creating the file, Keep a Changelog style, if none exists — and include it in the same commit that becomes the MR/PR.
- Language-agnostic check defaults: `build` / `lint` / `test` are auto-detected from the repo's toolchain — npm scripts (Node/TypeScript), .NET (`dotnet build/format/test`), Go (`go build/vet/test ./...`), Python (`pytest`). Explicit config always wins; an empty command skips the stage.

### Changed

- Removed the shipped `.env.example` / `.pipeline-worker.yml.example` templates. Real environment variables already take precedence over both files, so exporting `PIPELINE_WORKER_*` once in your shell profile now covers global setup across every repo — see the README Quick start. Per-repo `.env` / `.pipeline-worker.yml` are still supported as optional local overrides.

## [0.1.0] - 2026-07-01

### Added

- `run` workflow: diff capture → disposable worktree → agent intent capture → build/lint/test → commit → MR/PR → pipeline watch with bounded auto-fix loop.
- Forge support: GitLab (merge requests + pipelines) and GitHub (pull requests + Actions workflow runs).
- Agent support: Claude Code and GitHub Copilot CLI, selected via config.
- `serve`: companion forge MCP server with TOON-encoded, truncation-aware tool responses.
- `resume` / `status` commands backed by per-branch persisted run state.
- Configuration via `.pipeline-worker.yml`, `.env`, and `PIPELINE_WORKER_*` environment variables, including `pollIntervalSeconds`.
