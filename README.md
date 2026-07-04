# pipeline-worker

[![CI](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pipeline-worker)](https://www.npmjs.com/package/pipeline-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automate the last mile of your local changes: pipeline-worker takes the uncommitted diff in your repo and drives it — unattended to a green merge request.

1. Captures your staged + unstaged changes (your working tree is only read, not modified, up through this point).
2. Replays them in a disposable git worktree.
3. Asks a coding agent (Claude Code or GitHub Copilot CLI) to infer the intent: change type, branch slug, commit message, summary.
4. Runs your `build` / `lint` / `test` commands, fail-fast.
5. Commits, pushes, and opens a GitLab MR or GitHub PR — the branch name is composed from the configurable `branchPattern`.
6. Polls the CI pipeline; on failure it hands the pipeline URL to the agent, which pulls the failed jobs and logs itself via whatever GitLab/GitHub MCP tooling is available (pipeline-worker's own forge MCP server, or an external one the agent already has configured), commits the fix, pushes, and re-polls — capped at `maxFixAttempts` before escalating to a human with an MR comment.
7. Once the MR/PR is ready to merge (or, with `PIPELINE_WORKER_CLEANUP_EARLY`, as soon as the MR/PR is opened), resets your repo's current branch back to HEAD (see `PIPELINE_WORKER_CLEANUP` below) — your changes now live safely on the feature branch instead of sitting uncommitted locally too.

Polling is plain REST and costs zero agent tokens; the agent is invoked only when a pipeline actually fails, and fetches whatever pipeline/job detail it needs through pipeline-worker's token-efficient [TOON](https://github.com/toon-format/toon)-encoded MCP server (or an external forge MCP server, if the agent has one available).

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
| `PIPELINE_WORKER_GITHUB_REPO`           | auto-detected from `origin`  | `owner/name` slug — only needed when `origin` isn't a GitHub remote          |
| `PIPELINE_WORKER_GITHUB_TOKEN`          | falls back to `GITHUB_TOKEN` | GitHub token                                                                  |
| `PIPELINE_WORKER_POLL_INTERVAL_SECONDS` | `15`                         | pipeline poll cadence; use `60` for slow pipelines                            |
| `PIPELINE_WORKER_BRANCH_PATTERN`        | `pipeline-worker/{name}`     | feature branch naming template — see below                                    |
| `PIPELINE_WORKER_CLEANUP`               | `true`                       | reset repoRoot to HEAD once cleanup fires (see `PIPELINE_WORKER_CLEANUP_EARLY` for when) (`false` to keep your local uncommitted changes as-is) |
| `PIPELINE_WORKER_CLEANUP_EARLY`         | `false`                      | `true` resets repoRoot as soon as the MR/PR is opened (diff committed + pushed), instead of waiting for CI to go green — frees the repo (and the run lock) for a new `pipeline-worker run` while this run's CI-watch/fix loop keeps going in the background |
| `PIPELINE_WORKER_INTENT_MODEL`          | `haiku`                      | model used for the intent-capture step (branch/commit/summary); claude only — copilot has no per-invocation model selection and ignores it |
| `PIPELINE_WORKER_BUILD`                 | auto-detected from toolchain | build command override; set to an empty string to skip the stage                                                             |
| `PIPELINE_WORKER_LINT`                  | auto-detected from toolchain | lint command override; set to an empty string to skip the stage                                                              |
| `PIPELINE_WORKER_TEST`                  | auto-detected from toolchain | test command override; set to an empty string to skip the stage                                                              |
| `PIPELINE_WORKER_MAX_FIX_ATTEMPTS`      | `5`                          | how many CI-fix attempts before escalating to a human                                                                        |
| `PIPELINE_WORKER_RUN_LINT_AND_TEST`     | `true`                       | run the local lint and test stages (`false` to run only build — for repos where an earlier workflow, e.g. upstream CI, already verified lint/test) |
| `PIPELINE_WORKER_UPDATE_CHANGELOG`      | `false`                      | once checks pass, add a bullet (from the captured intent's summary) under `CHANGELOG.md`'s `[Unreleased]` section — `feature`/`bugfix`/`chore` map to the `Added`/`Fixed`/`Changed` categories — creating the file, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)-style, if the repo has none — and include it in the same commit |

### Branch naming

`PIPELINE_WORKER_BRANCH_PATTERN` controls the feature branch name, built from three placeholders:

| Placeholder | Filled by                                                          |
| ----------- | ------------------------------------------------------------------- |
| `{type}`    | `feature`, `bugfix`, or `chore` — inferred from the diff by the agent |
| `{ticket}`  | the `--ticket <id>` flag passed to `pipeline-worker run`             |
| `{name}`    | a short kebab-case slug describing the change — inferred by the agent |

For example, a team using GitLab issue-linked branches would set:

```sh
export PIPELINE_WORKER_BRANCH_PATTERN='{type}/{ticket}/{name}'
```

```sh
pipeline-worker run --ticket PROJ-123
# -> bugfix/PROJ-123/fix-login-redirect
```

A pattern that includes `{ticket}` requires `--ticket` to be passed; the run fails fast at the naming step otherwise.

### Check command auto-detection

`build` / `lint` / `test` are picked from the repo's toolchain (first marker found wins; mixed-language repos should set `PIPELINE_WORKER_BUILD` / `PIPELINE_WORKER_LINT` / `PIPELINE_WORKER_TEST` explicitly):

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
| `pipeline-worker` (or `pipeline-worker run`) `[--ticket <id>]` | Capture the current diff and drive it to a green MR/PR        |
| `pipeline-worker serve`                      | Start the forge MCP server over stdio (used by the agent during fix runs) |
| `pipeline-worker resume --branch <name>`     | Resume watching/fixing a run after a crash                                |
| `pipeline-worker status --branch <name>`     | Print the persisted state of a run                                        |
| `pipeline-worker sessions [--branch <name>]` | List every persisted run in this repo, or show one run's full step-by-step timeline |
| `pipeline-worker update`                     | Install the latest release from npm (`npm install -g pipeline-worker@latest`) |

Every time a run hands a turn to Claude Code or the Copilot CLI (resolving a conflict, capturing intent, fixing a failed pipeline), the output includes that turn's duration and an `agent session: <id>` line — `claude --resume <id>` (or `copilot --resume <id>`) opens the same session later to see exactly what it did and why. Copilot CLI has no way to report the session id it picked for itself, so pipeline-worker assigns one via `--name` instead and reports that.

## How the fix loop stays bounded

Every retry path has a cap: local checks abort the run before an MR is ever opened; if no CI pipeline shows up for the MR/PR within 60s, the run ends there instead of polling; otherwise pipeline polling gives up after a 2-hour safety window; fix attempts stop at `maxFixAttempts`; a fix attempt that changes no files, or a pipeline that ends `canceled`/`skipped`, escalates immediately instead of spending agent tokens. Escalation always leaves a comment on the MR/PR so a human knows to take over.

## License

[MIT](LICENSE)
