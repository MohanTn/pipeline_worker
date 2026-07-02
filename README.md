# pipeline-worker

[![CI](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pipeline-worker)](https://www.npmjs.com/package/pipeline-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automate the last mile of your local changes: pipeline-worker takes the uncommitted diff in your repo and drives it — unattended to a green merge request.

1. Captures your staged + unstaged changes (your working tree is never touched).
2. Replays them in a disposable git worktree.
3. Asks a coding agent (Claude Code or GitHub Copilot CLI) to infer the intent: branch name, commit message, summary.
4. Runs your `build` / `lint` / `test` commands, fail-fast.
5. Commits, pushes, and opens a GitLab MR or GitHub PR.
6. Polls the CI pipeline; on failure it hands the failing job logs to the agent, commits the fix, pushes, and re-polls — capped at `maxFixAttempts` before escalating to a human with an MR comment.

Polling is plain REST and costs zero agent tokens; the agent is invoked only when a pipeline actually fails, with truncated logs and a token-efficient [TOON](https://github.com/toon-format/toon)-encoded MCP server for anything more it needs.

## Requirements

- Node.js >= 20.12 and git
- One coding agent CLI on your PATH: [Claude Code](https://claude.com/claude-code) (`claude`) or [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) (`copilot`)
- A GitLab or GitHub token with API access to the repo

## Install

```sh
npm install -g pipeline-worker
```

## Quick start

Set these once in your shell profile (`~/.zshrc` / `~/.bashrc`) and every
repo on the machine picks them up — no per-repo setup needed:

```sh
export PIPELINE_WORKER_AGENT=claude
export PIPELINE_WORKER_FORGE=gitlab
export PIPELINE_WORKER_GITLAB_HOST=https://gitlab.example.com
export PIPELINE_WORKER_GITLAB_TOKEN=glpat-xxxxx
export PIPELINE_WORKER_GITLAB_REPO_BASE=$HOME/REPO   # local dir that mirrors the GitLab namespace root — enables auto-detected projectId in any repo underneath it
```

Then, in any repo:

```sh
cd your-repo
# hack, hack, hack — leave the changes uncommitted, then:
pipeline-worker
```

## Configuration

pipeline-worker is configured entirely through real environment variables — set them in your shell profile once, and every repo picks them up.

| Env var                                 | Default                      | Meaning                                                                       |
| --------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `PIPELINE_WORKER_AGENT`                 | `claude`                     | `claude` or `copilot`                                                         |
| `PIPELINE_WORKER_FORGE`                 | `gitlab`                     | `gitlab` or `github`                                                          |
| `PIPELINE_WORKER_GITLAB_HOST`           | —                            | e.g. `https://gitlab.example.com`                                             |
| `PIPELINE_WORKER_GITLAB_PROJECT_ID`     | —                            | numeric project id                                                            |
| `PIPELINE_WORKER_GITLAB_REPO_BASE`      | —                            | local dir mirroring the GitLab namespace root, for auto-detecting `projectId` |
| `PIPELINE_WORKER_GITLAB_TOKEN`          | —                            | GitLab API token                                                              |
| `PIPELINE_WORKER_GITHUB_REPO`           | —                            | `owner/name` slug                                                             |
| `PIPELINE_WORKER_GITHUB_TOKEN`          | falls back to `GITHUB_TOKEN` | GitHub token                                                                  |
| `PIPELINE_WORKER_POLL_INTERVAL_SECONDS` | `15`                         | pipeline poll cadence; use `60` for slow pipelines                            |

`build` / `lint` / `test` local check commands and `maxFixAttempts` (default `5`) are not configurable via env var — see auto-detection below.

### Check command auto-detection

`build` / `lint` / `test` are picked from the repo's toolchain (first marker found wins; mixed-language repos should set the commands explicitly):

| Toolchain         | Marker                                                 | build            | lint                                | test                                             |
| ----------------- | ------------------------------------------------------ | ---------------- | ----------------------------------- | ------------------------------------------------ |
| Node / TypeScript | `package.json`                                         | `npm run build`  | `npm run lint`                      | `npm test` — each only if the script is declared |
| .NET              | `*.sln` / `*.csproj` / `*.fsproj` / `*.vbproj` at root | `dotnet build`   | `dotnet format --verify-no-changes` | `dotnet test`                                    |
| Go                | `go.mod`                                               | `go build ./...` | `go vet ./...`                      | `go test ./...`                                  |
| Python            | `pyproject.toml` / `setup.py` / `requirements.txt`     | —                | —                                   | `pytest`                                         |

A stage with no command (`—`) is skipped. If no toolchain is detected and no commands are configured, all local checks are skipped with a warning.

## Commands

| Command                                      | What it does                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `pipeline-worker` (or `pipeline-worker run`) | Capture the current diff and drive it to a green MR/PR                    |
| `pipeline-worker serve`                      | Start the forge MCP server over stdio (used by the agent during fix runs) |
| `pipeline-worker resume --branch <name>`     | Resume watching/fixing a run after a crash                                |
| `pipeline-worker status --branch <name>`     | Print the persisted state of a run                                        |

## How the fix loop stays bounded

Every retry path has a cap: local checks abort the run before an MR is ever opened; pipeline polling gives up after a 2-hour safety window; fix attempts stop at `maxFixAttempts`; a fix attempt that changes no files, or a pipeline that ends `canceled`/`skipped`, escalates immediately instead of spending agent tokens. Escalation always leaves a comment on the MR/PR so a human knows to take over.

## License

[MIT](LICENSE)
