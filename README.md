# pipeline-worker

[![CI](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pipeline-worker)](https://www.npmjs.com/package/pipeline-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automate the last mile of your local changes: pipeline-worker takes the uncommitted diff in your repo and drives it — unattended — to a green merge request.

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

```sh
cd your-repo
cp $(npm root -g)/pipeline-worker/.env.example .env          # set tokens & defaults
cp $(npm root -g)/pipeline-worker/.pipeline-worker.yml.example .pipeline-worker.yml
# hack, hack, hack — leave the changes uncommitted, then:
pipeline-worker
```

## Configuration

Resolution order per value: **real environment variable → `.env` at repo root → `.pipeline-worker.yml` → built-in default.** Tokens must only be set as environment variables (or in `.env`, which is git-ignored) — never in the YAML file.

| YAML key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | `PIPELINE_WORKER_AGENT` | `claude` | `claude` or `copilot` |
| `forge` | `PIPELINE_WORKER_FORGE` | `gitlab` | `gitlab` or `github` |
| `gitlab.host` | `PIPELINE_WORKER_GITLAB_HOST` | — | e.g. `https://gitlab.example.com` |
| `gitlab.projectId` | `PIPELINE_WORKER_GITLAB_PROJECT_ID` | — | numeric project id |
| — | `PIPELINE_WORKER_GITLAB_TOKEN` | — | GitLab API token (env only) |
| `github.repo` | `PIPELINE_WORKER_GITHUB_REPO` | — | `owner/name` slug |
| — | `PIPELINE_WORKER_GITHUB_TOKEN` | falls back to `GITHUB_TOKEN` | GitHub token (env only) |
| `build` / `lint` / `test` | — | auto-detected (see below) | local check commands; set to `''` to skip a stage |
| `maxFixAttempts` | — | `5` | agent fix attempts before escalating |
| `pollIntervalSeconds` | `PIPELINE_WORKER_POLL_INTERVAL_SECONDS` | `15` | pipeline poll cadence; use `60` for slow pipelines |

See [`.env.example`](.env.example) and [`.pipeline-worker.yml.example`](.pipeline-worker.yml.example) for annotated templates.

### Check command auto-detection

When `build` / `lint` / `test` are not set, pipeline-worker picks defaults from the repo's toolchain (first marker found wins; mixed-language repos should set the commands explicitly):

| Toolchain | Marker | build | lint | test |
| --- | --- | --- | --- | --- |
| Node / TypeScript | `package.json` | `npm run build` | `npm run lint` | `npm test` — each only if the script is declared |
| .NET | `*.sln` / `*.csproj` / `*.fsproj` / `*.vbproj` at root | `dotnet build` | `dotnet format --verify-no-changes` | `dotnet test` |
| Go | `go.mod` | `go build ./...` | `go vet ./...` | `go test ./...` |
| Python | `pyproject.toml` / `setup.py` / `requirements.txt` | — | — | `pytest` |

A stage with no command (`—`, or `''` in the YAML) is skipped. If no toolchain is detected and no commands are configured, all local checks are skipped with a warning — configure them explicitly for any other stack (`build: make all`, etc.).

## Commands

| Command | What it does |
| --- | --- |
| `pipeline-worker` (or `pipeline-worker run`) | Capture the current diff and drive it to a green MR/PR |
| `pipeline-worker serve` | Start the forge MCP server over stdio (used by the agent during fix runs) |
| `pipeline-worker resume --branch <name>` | Resume watching/fixing a run after a crash |
| `pipeline-worker status --branch <name>` | Print the persisted state of a run |

## How the fix loop stays bounded

Every retry path has a cap: local checks abort the run before an MR is ever opened; pipeline polling gives up after a 2-hour safety window; fix attempts stop at `maxFixAttempts`; a fix attempt that changes no files, or a pipeline that ends `canceled`/`skipped`, escalates immediately instead of spending agent tokens. Escalation always leaves a comment on the MR/PR so a human knows to take over.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please note the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
