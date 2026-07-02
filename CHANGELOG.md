# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Language-agnostic check defaults: `build` / `lint` / `test` are auto-detected from the repo's toolchain — npm scripts (Node/TypeScript), .NET (`dotnet build/format/test`), Go (`go build/vet/test ./...`), Python (`pytest`). Explicit config always wins; an empty command skips the stage.

## [0.1.0] - 2026-07-01

### Added

- `run` workflow: diff capture → disposable worktree → agent intent capture → build/lint/test → commit → MR/PR → pipeline watch with bounded auto-fix loop.
- Forge support: GitLab (merge requests + pipelines) and GitHub (pull requests + Actions workflow runs).
- Agent support: Claude Code and GitHub Copilot CLI, selected via config.
- `serve`: companion forge MCP server with TOON-encoded, truncation-aware tool responses.
- `resume` / `status` commands backed by per-branch persisted run state.
- Configuration via `.pipeline-worker.yml`, `.env`, and `PIPELINE_WORKER_*` environment variables, including `pollIntervalSeconds`.
