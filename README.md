# pipeline-worker

[![CI](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pipeline-worker)](https://www.npmjs.com/package/pipeline-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Automate the last mile of your local changes: pipeline-worker takes the uncommitted diff in your repo and drives it — unattended — all the way to a merged, locally-synced result.

1. Captures your staged + unstaged changes (your working tree is only read, not modified, up through this point).
2. Replays them in a disposable git worktree.
3. Asks a coding agent (Claude Code, [Pi](https://pi.dev), or GitHub Copilot CLI) to infer the intent: change type, branch slug, commit message, summary.
4. Runs your `build` / `lint` / `test` commands, fail-fast.
5. Commits, pushes, and opens a GitLab MR or GitHub PR — the branch name is composed from the configurable `branchPattern`, and the MR/PR targets origin's default branch (`main` or `master`, auto-detected), or whatever you pass to `--target`. **If the branch you are standing on already has an open MR/PR** (the reviewer-asked-for-a-change case), nothing new is opened: the commit lands on that same branch and a file-wise breakdown of this follow-up is *appended* to its description, leaving everything already written there intact.
6. Polls the CI pipeline; on failure it hands the pipeline URL to the agent, which pulls the failed jobs and logs itself via whatever GitLab/GitHub MCP tooling is available (pipeline-worker's own forge MCP server, or an external one the agent already has configured), commits the fix, pushes, and re-polls — capped at `maxFixAttempts` before escalating to a human with an MR comment.
7. Once the MR/PR is ready to merge (or, with `cleanupEarly`, as soon as the MR/PR is opened), resets your repo's current branch back to HEAD (see `cleanupOnSuccess` below) — your changes now live safely on the feature branch instead of sitting uncommitted locally too.
8. By default (`autoMergeOnGreen`), waits for the forge to confirm the auto-merge actually landed, then (after a few seconds' grace for the ref to settle) fast-forwards your local target branch from origin — so your local main already contains the merged result when the run ends. Best-effort: if the merge is held up (e.g. by required approvals), you switched branches mid-run, or your local target branch diverged, it leaves everything untouched and tells you to `git pull` instead. Set `"autoMergeOnGreen": false` to go back to opening the MR/PR and merging it yourself.
9. Finally, checks the feature branch out in your repo (`switchToFeatureBranch`, on by default), so the next change you make there becomes a **follow-up commit on the same MR/PR** instead of needing a new branch — see [Following up on a PR/MR under review](#following-up-on-a-prmr-under-review).

While attached to a real terminal, the run renders as a live step tree — header line, then one row per step (capture, worktree, checks, ci-watch, merge, ...) with a status glyph, duration, and best-effort token count, updated in place. CI logs and piped output fall back to the previous append-only narration (or force it yourself with `"plainOutput": true`).

Polling costs zero agent tokens; the agent is invoked only when a pipeline actually fails, and fetches whatever pipeline/job detail it needs through pipeline-worker's token-efficient [TOON](https://github.com/toon-format/toon)-encoded MCP server (or an external forge MCP server, if the agent has one available). GitHub polling is plain REST; GitLab polling shells out to the [`glab`](https://gitlab.com/gitlab-org/cli) CLI.

## Requirements

- Node.js >= 20.12 and git
- One coding agent CLI on your PATH: [Claude Code](https://claude.com/claude-code) (`claude`), [Pi](https://pi.dev) (`pi`), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) (`copilot`)
- A GitLab or GitHub token with API access to the repo
- If `"forge": "gitlab"`: the [`glab`](https://gitlab.com/gitlab-org/cli) CLI on your PATH — pipeline-worker authenticates it non-interactively by passing `GITLAB_TOKEN` and `--hostname` when it calls `glab api`

### Agents

| CLI | `agent` | Setup | Per-invocation model selection |
| --- | ----------------------- | ----- | ------------------------------ |
| [Claude Code](https://claude.com/claude-code) | `claude` | `npm install -g @anthropic-ai/claude-code` | ✅ (`--model`) |
| [Pi](https://pi.dev) | `pi` | `npm install -g @earendil-works/pi-coding-agent` | ✅ (`--model`) — any provider/model |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) | `copilot` | Install via [GitHub's docs](https://docs.github.com/en/copilot/how-tos/copilot-cli) | ✅ (`--model`) — Copilot's own model names; the `haiku`/`sonnet` aliases are mapped automatically |

Pi supports models from any provider — Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, OpenRouter, etc.
Configure your provider/api-key via pi's own setup (`/login`), env vars, or `--provider` in the adapter.

## Install

```sh
npm install -g pipeline-worker
```

This installs two equivalent commands, `pipeline-worker` and the shorter `pw` — use whichever you prefer (e.g. `pw run --ticket PROJ-123`).

## Quick start

The first run writes `~/.config/pipeline-worker/config.json` with every
setting at its default. Fill in the forge details once and every repo on the
machine picks them up — no per-repo setup needed:

```jsonc
{
  "agent": "claude",                  // or "pi", or "copilot"
  "forge": "gitlab",
  "gitlab": {
    "host": "https://gitlab.example.com",
    "token": "glpat-xxxxx",
    "repoBase": "/home/you/REPO"      // local dir mirroring the GitLab namespace root — enables auto-detected projectId in any repo underneath it
  }
}
```

(The file itself is plain JSON — the `//` comments above are just annotations for this README.)

Then, in any repo:

```sh
cd your-repo
# hack, hack, hack — leave the changes uncommitted, then:
pipeline-worker
```

## Configuration

pipeline-worker reads exactly one file: `~/.config/pipeline-worker/config.json`
(`$XDG_CONFIG_HOME/pipeline-worker/config.json` when that variable is set). It
is created, populated with every default, on the first run. There are **no
environment variables and no per-repo config file** — one file configures every
repo, and the per-repo values (`github.repo`, `gitlab.projectId`,
`build`/`lint`/`test`) are auto-detected from the repo itself unless the file
names them.

| Key                     | Default                      | Meaning                                                                       |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `agent`                 | `claude`                     | `claude`, `pi`, or `copilot`                                                   |
| `forge`                 | `gitlab`                     | `gitlab` or `github`                                                          |
| `gitlab.host`           | —                            | e.g. `https://gitlab.example.com`                                             |
| `gitlab.projectId`      | auto-detected from `repoBase` | numeric project id, or a `group/subgroup/project` path                       |
| `gitlab.repoBase`       | —                            | local dir mirroring the GitLab namespace root, for auto-detecting `projectId` |
| `gitlab.token`          | —                            | GitLab API token (passed to `glab` as `GITLAB_TOKEN`, never logged)           |
| `github.repo`           | auto-detected from `origin`  | `owner/name` slug — only needed when `origin` isn't a GitHub remote           |
| `github.token`          | —                            | GitHub token (never logged)                                                   |
| `github.apiUrl`         | `https://api.github.com`     | REST API base URL — point it at your GitHub Enterprise instance               |
| `pollIntervalSeconds`   | `15`                         | pipeline poll cadence; use `60` for slow pipelines                            |
| `branchPattern`         | `pipeline-worker/{name}`     | feature branch naming template — see below                                    |
| `cleanupOnSuccess`      | `true`                       | reset repoRoot to HEAD once cleanup fires (see `cleanupEarly` for when) (`false` to keep your local uncommitted changes as-is) |
| `cleanupEarly`          | `false`                      | `true` resets repoRoot as soon as the MR/PR is opened (diff committed + pushed), instead of waiting for CI to go green — frees the repo (and the run lock) for a new `pipeline-worker run` while this run's CI-watch/fix loop keeps going in the background |
| `switchToFeatureBranch` | `true`                       | when the run finishes green, check the feature branch out in your repo so your next change becomes a follow-up commit on the same MR/PR — see [Following up on a PR/MR under review](#following-up-on-a-prmr-under-review). Skipped (with a note) when the working tree still has uncommitted changes |
| `intentModel`           | `haiku`                      | model used for the intent-capture step (branch/commit/summary). All three agents pass it via `--model`; for copilot, the `haiku`/`sonnet` aliases are translated to Copilot's own model names (`claude-haiku-4.5`/`claude-sonnet-4.5`), anything else is passed through verbatim |
| `build`                 | auto-detected from toolchain | build command override; set to an empty string to skip the stage              |
| `lint`                  | auto-detected from toolchain | lint command override; set to an empty string to skip the stage               |
| `test`                  | auto-detected from toolchain | test command override; set to an empty string to skip the stage               |
| `maxFixAttempts`        | `5`                          | how many CI-fix attempts before escalating to a human — tracked independently from merge-conflict-resolution attempts, so a long-lived PR needing several rebases can't exhaust the budget meant for real bug-fixing |
| `runLintAndTest`        | `true`                       | run the local lint and test stages (`false` to run only build — for repos where an earlier workflow, e.g. upstream CI, already verified lint/test) |
| `updateChangelog`       | `false`                      | once checks pass, add a bullet (from the captured intent's summary) under `CHANGELOG.md`'s `[Unreleased]` section — `feature`/`bugfix`/`chore` map to the `Added`/`Fixed`/`Changed` categories — creating the file, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)-style, if the repo has none — and include it in the same commit |
| `autoMergeOnGreen`      | `true`                       | once the MR/PR opens, ask the forge to merge it automatically as soon as CI (and any required approvals) allow — best-effort; if the forge rejects it (auto-merge not enabled for the repo, pending approvals, ...) the run continues normally and you merge manually. Once the forge confirms the merge landed, the run also fast-forwards your local target branch from origin (waiting a few seconds for the ref to settle first), so your local main is already up to date when the run ends. Set to `false` to go back to opening the MR/PR and merging it yourself |
| `mergeMethod`           | `squash`                     | `merge`, `squash`, or `rebase` — passed to auto-merge. GitLab has no per-request rebase option; `rebase` there falls back to the project's own default merge method |
| `squashOnMerge`         | `false`                      | once CI is green, collapse every commit this run made on the branch into one (titled from the captured intent) and force-push — keeps history clean regardless of the repo's merge-strategy setting. Off by default: rewrites published history (force-push), a materially different risk from everything else this tool does. Only reliable with auto-merge off — the forge may already have merged (and deleted) the branch before this step runs |
| `review`                | `false`                      | once the MR/PR is open, have the agent review its diff and post line-anchored comments on the lines it flags — see [AI code review](#ai-code-review). Best-effort: it never fails the run |
| `reviewModel`           | adapter default              | model for the review turns. Unset means the agent's own default (deliberately stronger than `intentModel` — finding real bugs is not the cheap-model job) |
| `reviewMinSeverity`     | `MAJOR`                      | `CRITICAL`, `MAJOR`, or `MINOR` — findings below this are never posted. The anti-alert-fatigue gate: at the default, style nitpicks never reach the MR/PR |
| `reviewMaxComments`     | `10`                         | hard cap on comments posted per run, most severe first                        |
| `reviewChunkChars`      | `24000`                      | char budget per diff chunk (one agent turn per chunk) — lower it for a smaller-context model |
| `completionSound`       | `true`                       | play a soft system sound when the run settles — best-effort, silently skipped when no audio player is available |
| `plainOutput`           | `false`                      | force the append-only, non-redrawing narration even on a real terminal (the same output CI/piped runs always get) — useful when pasting output into a bug report or feeding it to another tool |

Booleans are real JSON booleans; the string spellings `"true"`/`"false"`,
`"1"`/`"0"`, `"yes"`/`"no"`, `"on"`/`"off"` are accepted too (case-insensitive,
surrounding whitespace ignored). Any other value is ignored with a warning
naming the key, and the default applies. A malformed or unreadable file warns
and falls back to defaults wholesale — it never blocks a run.

### Branch naming

`branchPattern` controls the feature branch name, built from three placeholders:

| Placeholder | Filled by                                                          |
| ----------- | ------------------------------------------------------------------- |
| `{type}`    | `feature`, `bugfix`, or `chore` — inferred from the diff by the agent |
| `{ticket}`  | the `--ticket <id>` flag passed to `pipeline-worker run`             |
| `{name}`    | a short kebab-case slug describing the change — inferred by the agent |

For example, a team using GitLab issue-linked branches would set:

```json
{ "branchPattern": "{type}/{ticket}/{name}" }
```

```sh
pipeline-worker run --ticket PROJ-123
# -> bugfix/PROJ-123/fix-login-redirect
```

A pattern that includes `{ticket}` requires `--ticket` to be passed; the run fails fast at the naming step otherwise.

### Check command auto-detection

`build` / `lint` / `test` are picked from the repo's toolchain (first marker found wins; mixed-language repos should set `build` / `lint` / `test` explicitly):

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
| `pipeline-worker` (or `pipeline-worker run`) `[--ticket <id>] [--target <branch>]` | Capture the current diff and drive it to a green MR/PR |
| `pipeline-worker serve`                      | Start the forge MCP server over stdio (used by the agent during fix runs) |
| `pipeline-worker resume --branch <name>` `[--target <branch>]` | Resume watching/fixing a run after a crash, or adopt a branch pipeline-worker has no record of |
| `pipeline-worker review --branch <name>`     | Review that branch's open MR/PR with the agent and post line-anchored comments (nothing else) |
| `pipeline-worker status --branch <name>`     | Print the persisted state of a run                                        |
| `pipeline-worker sessions [--branch <name>]` | List every persisted run in this repo, or show one run's full step-by-step timeline |
| `pipeline-worker update`                     | Install the latest release from npm (`npm install -g pipeline-worker@latest`) |

Before doing any work, `pipeline-worker run` checks npm for a newer published version and installs it automatically if the locally installed one is out of date (the update takes effect on the next run). This check is best-effort: if npm is unreachable or the install fails, the run proceeds anyway on whatever version is already installed.

### Following up on a PR/MR under review

A run leaves you standing on the feature branch it just built (`switchToFeatureBranch`, on by default) — so "make one more change" needs no `git checkout` and no hunt for the run's now-deleted worktree. A reviewer comments, you make the fix locally, you run `pipeline-worker` again from that same branch. Because the branch already has an open MR/PR, the run does **not** open a second one:

- the target branch comes from the MR/PR itself, not from `--target`/default-branch detection;
- the worktree rebases onto the MR/PR's own branch first, so a commit pushed there in the meantime (a reviewer's fixup, another run) is never clobbered;
- checks, intent capture, and the commit all run as usual, then the commit is pushed onto that same branch;
- the file-wise breakdown of this change is **appended** to the MR/PR description under a `🔁 Follow-up` heading — the original description, the reviewer's edits, and any earlier follow-ups all stay above it;
- CI is then watched (and auto-fixed) exactly as on a first run. `squashOnMerge` is skipped here: rewriting the history of a PR under review would detach the comments anchored to it.

The commit is made in the run's own worktree, so your local branch does not have it — `git pull` once the run finishes.

If the working tree still holds uncommitted changes when the run ends (`"cleanupOnSuccess": false`), the switch is skipped with a note rather than dragging them onto the feature branch; `git checkout <branch>` yourself when you have dealt with them.

### AI code review

With `"review": true`, the run adds one stage right after the MR/PR is opened and before CI is watched: the agent reviews the branch's own diff and comments **on the diff lines**, not in the description.

- **Chunking** — the diff is split per file, and a file larger than `reviewChunkChars` is split further, so a large MR/PR never overflows the model's context. One agent turn per chunk; each carries the file name, its language, and the surrounding lines.
- **Line targeting** — every line in a chunk is presented with its line number in the *new* file, and a finding may only anchor to an added (`+`) line. Anything else the model returns (an old-file number, a hallucinated one, a file not in the diff) is dropped before any API call.
- **One-click fixes** — comments carry a ` ```suggestion ` block where a concrete fix fits, in the dialect the active forge accepts (GitLab's ` ```suggestion:-0+0 `).
- **Gatekeeping** — the reviewer is instructed to report only logic errors, security holes, performance problems, and severe anti-patterns; on top of that, findings below `reviewMinSeverity` are dropped, duplicates on the same file+line are collapsed, and at most `reviewMaxComments` are posted, most severe first. A clean diff produces no comments at all.
- **Best-effort** — a failure anywhere in this stage (unusable agent output, a forge rejecting a position, an unreachable merge-base) becomes a note; the run's outcome is unchanged.

A follow-up run on a branch whose MR/PR is already open reviews only the files *that* run touched, so lines a human has already reviewed are not commented on again.

`pipeline-worker review --branch <name>` runs just this stage against a branch's open MR/PR — no checks, no commit, no CI watch — and ignores `review`, since asking for it explicitly is the opt-in.

### Target branch

`pipeline-worker run` targets origin's default branch, resolved in this order: `--target <branch>` if you passed one (validated against origin before any work starts), else `refs/remotes/origin/HEAD`, else the remote's HEAD symref, else whichever of `main`/`master` origin actually has (when both exist, the one your HEAD's merge-base is closest to). Only if origin can't answer at all does it fall back to the branch you are standing on.

### Adopting a branch: never run, or run and stalled

`pipeline-worker resume --branch <name>` also works for a branch with no *resumable* run behind it — one you committed and pushed by hand, or one whose run pushed the branch and then died before the PR/MR existed (the forge went down, the process was killed). Both are recovered the same way: it checks out the branch as origin has it and checks the forge for an open PR/MR for it:

- **No PR/MR yet:** runs it like a fresh `pipeline-worker run` from this point on — build/lint/test checks (aborting the same way a normal run does on failure), intent capture, then opens the MR/PR — targeting `--target <branch>` if given, or origin's auto-detected default branch otherwise.
- **PR/MR already open:** re-captures intent from the branch's actual diff, overwrites the PR/MR's description with it (using the PR/MR's own target branch — no guessing needed), and resumes the normal watch/fix loop: poll CI, and on failure pull the failed jobs' logs, hand them to the agent to fix, commit, push, and repoll.

A stalled run's own target branch is reused unless you pass `--target`. If the branch was never pushed there is nothing to adopt, and the command says so rather than failing inside git.

Every time a run hands a turn to the agent (resolving a conflict, capturing intent, fixing a failed pipeline), the output includes that turn's duration and an `agent session: <id>` line — `claude --resume <id>`, `pi --session <id>`, or `copilot --resume <id>` opens the same session later to see exactly what it did and why. Copilot CLI has no way to report the session id it picked for itself, so pipeline-worker assigns one via `--name` instead and reports that.

## How the fix loop stays bounded

Every retry path has a cap: local checks abort the run before an MR is ever opened; if no CI pipeline shows up for the MR/PR within 60s, the run ends there instead of polling; otherwise pipeline polling gives up after a 2-hour safety window; fix attempts stop at `maxFixAttempts`; a fix attempt that changes no files, or a pipeline that ends `canceled`/`skipped`, escalates immediately instead of spending agent tokens. Escalation always leaves a comment on the MR/PR so a human knows to take over.

## License

[MIT](LICENSE)
