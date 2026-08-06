# pipeline-worker

[![CI](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml/badge.svg)](https://github.com/MohanTn/pipeline_worker/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pipeline-worker)](https://www.npmjs.com/package/pipeline-worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Takes the uncommitted diff in your repo and drives it — unattended — to a merged, locally-synced result.

1. Captures your staged + unstaged changes and replays them in a disposable git worktree (your working tree is only read).
2. Asks a coding agent to infer intent: change type, branch slug, commit message, summary.
3. Runs `build` / `lint` / `test`, fail-fast.
4. Commits, pushes, opens a GitLab MR or GitHub PR against origin's default branch (or `--target`). If the current branch already has an open MR/PR, no second one is opened: the commit lands on it and a follow-up breakdown is appended to its description.
5. Polls CI; on failure hands the pipeline to the agent, which inspects the failure itself via the forge CLI (`glab`/`gh`), commits the fix, pushes, and re-polls — capped at `maxFixAttempts` before escalating with an MR/PR comment.
6. Resets your repo back to HEAD, waits for the auto-merge to land, fast-forwards your local target branch, then checks the feature branch out so your next change becomes a follow-up commit.

Polling costs zero agent tokens; the agent runs only when a pipeline actually fails. On a terminal the run renders as a live step tree — inside the TUI's own screen when started from there, or as a scrollback dashboard from the plain CLI; piped output falls back to append-only narration (or set `plainOutput`).

## Demo

| Home | Settings | Live run |
| --- | --- | --- |
| ![TUI home menu](images/tui-home.png) | ![TUI settings editor](images/tui-settings.png) | ![TUI live run dashboard](images/tui-run.png) |

## Requirements

- Node.js >= 20.12 and git
- One agent CLI on PATH: `claude`, `pi`, `copilot`, or `little-coder`
- A GitLab or GitHub token with API access
- For `"forge": "gitlab"`: the [`glab`](https://gitlab.com/gitlab-org/cli) CLI (authenticated non-interactively via `GITLAB_TOKEN` + `--hostname`)
- Optional, either forge: an authenticated [`glab`](https://gitlab.com/gitlab-org/cli)/[`gh`](https://cli.github.com/) CLI on the agent's PATH gives a CI-fix turn a fallback way to dig deeper into a failure. pipeline-worker fetches the failed jobs' logs itself first and embeds them in the fix prompt, so this isn't required — without it, the agent works from that embedded output (and from re-running local checks) instead.

## Install

```sh
npm install -g pipeline-worker
```

Installs two equivalent commands: `pipeline-worker` and `pw`.

## Quick start

The first run writes `~/.config/pipeline-worker/config.json` with every setting at its default. Fill in the forge details once and every repo on the machine picks them up:

```json
{
  "agent": "claude",
  "forge": "gitlab",
  "gitlab": {
    "host": "https://gitlab.example.com",
    "token": "glpat-xxxxx",
    "repoBase": "/home/you/REPO"
  }
}
```

Or let the setup guide fill that file in for you — run `pipeline-worker` in any repo and pick **Setup guide**:

```sh
cd your-repo
pipeline-worker          # interactive TUI: run, sessions, settings, setup guide

# hack, hack, hack — leave the changes uncommitted, then:
pipeline-worker run      # straight to the workflow, no menus
```

## Configuration

One file only: `~/.config/pipeline-worker/config.json` (`$XDG_CONFIG_HOME` honored). No environment variables, no per-repo file, no CLI flags for settings. Per-repo values (`github.repo`, `gitlab.projectId`, `build`/`lint`/`test`) are auto-detected unless the file names them.

**See [`config.example.jsonc`](config.example.jsonc) for every supported field, its default, and what it does.**

Booleans may also be written as `"true"`/`"false"`, `"1"`/`"0"`, `"yes"`/`"no"`, `"on"`/`"off"`. An unrecognized value warns and falls back to the default; a malformed file warns and falls back wholesale — it never blocks a run.

### Agents

| CLI | `agent` | Install |
| --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | `claude` | `npm install -g @anthropic-ai/claude-code` |
| [Pi](https://pi.dev) | `pi` | `npm install -g @earendil-works/pi-coding-agent` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) | `copilot` | see GitHub's docs |
| [little-coder](https://github.com/itayinbarr/little-coder) | `little-coder` | see its README (llama.cpp/Ollama) |

All four take a per-invocation `--model`. Pi accepts any provider/model (configure via `/login` or env vars); Copilot's `haiku`/`sonnet` aliases are mapped to its own names automatically.

### Branch naming

`branchPattern` is built from `{type}` (`feature`/`bugfix`/`chore`, inferred), `{ticket}` (from `--ticket`), and `{name}` (an inferred kebab-case slug):

```sh
# with "branchPattern": "{type}/{ticket}/{name}"
pipeline-worker run --ticket PROJ-123   # -> bugfix/PROJ-123/fix-login-redirect
```

A pattern containing `{ticket}` fails fast if `--ticket` is missing.

### What each agent turn is allowed to do

Each turn gets a one-sentence `--system-prompt` and a gated tool set. On `claude` the gate is real: `--tools` decides which built-ins exist at all, so a turn cannot ask permission for one it lacks.

| Turn | Tools |
| --- | --- |
| intent capture | `Read` — the diff is embedded in the prompt (capped at 20000 chars, trimmed middle-out) |
| conflict resolution | `Read`, `Write`, `Edit` — staging and committing stay with pipeline-worker |
| MR/PR review | `Read` — works from the diff in its prompt, one turn per `reviewChunkChars` of diff |
| MR/PR comment replies | `Read` — one turn carrying every open thread plus the diff |
| CI fix / local check fix | unrestricted — fixing a red build means running the failing command |

`copilot` has no per-invocation allowlist (`--allow-all-tools` is required unattended), so its turns get full tool access; the system prompt still applies.

### Running on a local model

`"agent": "little-coder"` drives pi tuned for 5-25GB local models. Every prompt is trimmed to `littleCoder.maxPromptChars` middle-out (keeping the system instruction and the JSON contract), turns are tool-gated, and `intentModel`/`reviewModel` take little-coder's `provider/id` form:

```json
{
  "agent": "little-coder",
  "littleCoder": { "binary": "little-coder", "maxPromptChars": 12000 },
  "intentModel": "llamacpp/qwen3-30b",
  "reviewFilesPerTurn": 2,
  "review": false
}
```

little-coder's own `LITTLE_CODER_BASH_ALLOW` and model profiles (`.pi/settings.json`) stay yours to configure.

### Check command auto-detection

First marker found wins; set `build`/`lint`/`test` explicitly in mixed-language repos.

| Toolchain | Marker | build | lint | test |
| --- | --- | --- | --- | --- |
| Node / TypeScript | `package.json` | `npm run build` | `npm run lint` | `npm test` — each only if declared |
| .NET | `*.sln` / `*.csproj` / `*.fsproj` / `*.vbproj` | `dotnet build` | `dotnet format --verify-no-changes` | `dotnet test` |
| Go | `go.mod` | `go build ./...` | `go vet ./...` | `go test ./...` |
| Python | `pyproject.toml` / `setup.py` / `requirements.txt` | — | — | `pytest` |

A stage with no command is skipped. No toolchain and no configured commands means all local checks are skipped with a warning.

## Commands

| Command | What it does |
| --- | --- |
| `pipeline-worker` | On a terminal, opens the TUI; with any argument or when redirected, behaves as `run` |
| `pipeline-worker tui` | Full-screen dashboard: runs, sessions, settings editor, setup guide |
| `pipeline-worker run [--ticket <id>] [--target <branch>]` | Capture the current diff and drive it to a green MR/PR |
| `pipeline-worker resume --branch <name> [--target <branch>]` | Resume a crashed run, or adopt a branch it has no record of |
| `pipeline-worker review --branch <name>` | Review that branch's open MR/PR, post line-anchored comments, reply to the comments already on it (scanner findings included), and approve it when nothing was flagged |
| `pipeline-worker fix --branch <name>` | Fix the code that branch's MR/PR comments point at (bots included), push it, and reply to every thread |
| `pipeline-worker status --branch <name>` | Print the persisted state of a run |
| `pipeline-worker sessions [--branch <name>]` | List persisted runs, or one run's full timeline |
| `pipeline-worker update` | Install the latest release from npm |

`run` self-updates from npm first (best-effort; takes effect next run). Every agent turn reports its duration and an `agent session: <id>` — replay it with `claude --resume <id>`, `pi --session <id>`, or `copilot --resume <id>`.

### Interactive TUI

`pipeline-worker` with no arguments on a terminal (or `pipeline-worker tui` anywhere) opens a full-screen dashboard:

```
┌ pipeline-worker · settings ──────────────────────────────────────────────────┐
│ ── Agent & forge ─────────────────────────────────────────────────────────── │
│ ❯  agent                   claude                                       file │
│    forge                   gitlab                                       file │
│    bareAgentMode           on                                        default │
│ ── GitHub ────────────────────────────────────────────────────────────────── │
│    repo                    you/your-repo                                auto │
│                                                                              │
│ ── agent ─────────────────────────────────────────────────────────────────── │
│ Which coding-agent CLI runs the intent capture, CI fixes, conflict           │
│ resolution, and reviews. Choices: claude / copilot / pi / little-coder.      │
└ ↑↓ move · ⏎ edit/toggle · d default · ? help · q back ───────────────────────┘
```

- **Run workflow** — start a run, optionally with a ticket or target branch.
- **Sessions** — browse this repo's runs and drill into one's timeline; `r` resumes it, `v` reviews its MR/PR.
- **Settings** — every key with the value in force, where it came from (`file` you set it, `auto` detected from the repo, `default` built in), and `?` for what it does. Edits save immediately; `d` clears a key back to auto-detection.
- **Setup guide** — the questions that decide whether pipeline-worker can run at all (forge, credentials, agent), each explaining why it is being asked. Nothing is written until you confirm.

Starting a run, a resume, or a review opens the same live step dashboard inside the TUI's own screen, and returns to the TUI once it settles. Everything remains scriptable: any argument, or a redirected stdin/stdout, skips the TUI entirely and runs the plain, non-interactive CLI instead.

### Following up on a PR/MR under review

A run leaves you on the feature branch it built, so "one more change" needs no `git checkout`. Run `pipeline-worker` again from there and, because the branch has an open MR/PR:

- the target branch comes from the MR/PR itself, not from `--target`;
- the worktree rebases onto the MR/PR's branch first, so commits pushed meanwhile are never clobbered;
- the new breakdown is **appended** under a `🔁 Follow-up` heading, leaving the original description and reviewer edits intact;
- CI is watched and auto-fixed as usual. `squashOnMerge` is skipped — rewriting history would detach anchored comments.

The commit is made in the run's own worktree, so `git pull` once it finishes. If the working tree still has uncommitted changes (`"cleanupOnSuccess": false`), the branch switch is skipped with a note.

### AI code review

With `"review": true`, the agent reviews the branch diff right after the MR/PR opens and comments **on the diff lines**:

- **One session per MR/PR** — the whole diff goes to the agent in a single turn, each file as its own labeled section, working from the diff only. A diff over `reviewChunkChars` (default 200000, ~50k tokens) splits into as few further turns as it takes. `little-coder` instead gets 3 files per turn, clamped under its `maxPromptChars`; set `reviewFilesPerTurn` to pin the group size for any agent.
- **Line targeting** — findings may only anchor to an added (`+`) line; anything else the model returns is dropped before any API call.
- **One-click fixes** — comments carry a ` ```suggestion ` block in the active forge's dialect.
- **Gatekeeping** — only logic errors, security holes, performance problems, and severe anti-patterns; findings below `reviewMinSeverity` are dropped, duplicates collapsed, at most `reviewMaxComments` posted, most severe first.
- **Best-effort** — any failure here becomes a note; the run's outcome is unchanged.

A follow-up run reviews only the files *that* run touched. `pipeline-worker review --branch <name>` runs this stage alone and ignores the `review` setting.

#### Answering the comments already there

`pipeline-worker review --branch <name>` does one thing the automatic stage does not: once its own comments are posted, it reads every **open** thread on the MR/PR — human comments and scanner findings alike (**SonarQube** and **Checkmarx** are recognized and labelled for the agent) — and replies where it matters:

- **Confirm** — the thread names a real problem in this diff at or above `reviewMinSeverity`; the reply says so and gives the fix.
- **Correct** — the thread points at the wrong line, misreads the code, or recommends something that should not be done here (a scanner false positive included). The reply opens with `This is not recommended because: …` and gives the reason. Corrections ignore the severity floor: a wrong steer costs time whatever it was pointing at.

Replies are threaded (GitLab discussion notes, GitHub review-comment replies); a GitHub PR-level comment has no thread, so its reply is a new comment quoting the original. Resolved threads are skipped, pipeline-worker never answers its own comments, and at most `reviewMaxComments` replies are posted per run. The automatic review inside `run`/`resume` skips all of this — a freshly opened MR/PR has nothing to answer.

#### Acting on the comments: `pipeline-worker fix --branch <name>`

`review` answers the threads on an MR/PR; `fix` **does what they ask**. It checks the branch out into a disposable worktree, hands the agent every open thread — humans and bots alike (**CodeRabbit**, **SonarQube** and **Checkmarx** are recognized and labelled) — along with the branch diff, and lets it edit the code:

- **Fixed** — the comment is right, so the agent changes the code. All accepted fixes land as **one commit** on the same branch (`fix: address N review comment(s) on !42`), and each thread is answered `Fixed in <sha>: …`.
- **Invalid** — the comment misreads the code, points at the wrong place, or recommends something that must not be done here (the common case for a scanner false positive). Nothing is edited and the thread is answered `This is not recommended because: …`.

Two guards decide what actually reaches the branch: **`build`/`lint`/`test` must pass in the worktree before anything is pushed** (a failing check aborts the command with nothing pushed and no replies posted), and a thread the agent *claims* to have fixed while leaving every file untouched is **dropped rather than answered** — a reply pointing at a commit that carries nothing is worse than no reply. Unlike `review`, this command is not best-effort: a forge that cannot be read or a check that fails is a failed command, not a note. It never approves and never merges.

#### Approving a clean review

`pipeline-worker review --branch <name>` finishes by **approving** the MR/PR, but only when the whole review vouches for it:

- the review read a real diff and raised **nothing** at or above `reviewMinSeverity`;
- nothing in the open threads was something the agent had to **confirm** (a correction does not block — the point was raised and refuted);
- the forge reports **no merge conflicts** against the target branch.

Anything else — a finding posted, a comment confirmed, a stage that failed or was skipped — leaves the MR/PR unapproved. "We could not look" never counts as "we looked and it was fine". Set `"reviewApprove": false` to keep approving a human-only act. `run`/`resume` never approve at all: a run reviewing its own diff is not a reviewer.

Approval is best-effort, and both forges refuse it for reasons nothing here can fix — **GitHub rejects approving your own pull request** (the usual case when pipeline-worker opened it, so use a separate reviewer token to make this work), and **GitLab's approvals API is a paid-tier feature** that answers 404 on Free. Either refusal becomes a note; the command's outcome is unchanged.

### Target branch

Resolved in order: `--target` (validated against origin first), `refs/remotes/origin/HEAD`, the remote's HEAD symref, then whichever of `main`/`master` origin has (closest merge-base wins if both). Only if origin can't answer does it fall back to your current branch.

### Resuming a failed run

A run that fails keeps its worktree — nothing is deleted until a run finishes cleanly — and records the stage it died in. `pipeline-worker resume --branch <name>` (the branch is in the failure message) re-enters that same worktree at that same stage: everything already done is skipped, so a run that failed committing commits and carries on, and a run that failed on `build` re-runs the checks against whatever you fixed inside the worktree. Your own repo is left exactly as it was, uncommitted changes included, so nothing is lost either way.

Once the worktree is gone (you removed it, or the run finished), `resume` falls back to the origin-based recovery below.

### Adopting a branch

`pipeline-worker resume --branch <name>` also handles a branch with no resumable run — one you pushed by hand, or one whose run died before the PR/MR existed. It checks the branch out as origin has it and asks the forge:

- **No PR/MR yet** — runs like a fresh `run` from that point: checks, intent capture, then opens the MR/PR.
- **PR/MR open** — re-captures intent from the branch's diff, overwrites the description, and resumes the watch/fix loop.

A stalled run reuses its own target branch unless you pass `--target`. An unpushed branch is reported as nothing to adopt.

## How the fix loop stays bounded

Local checks abort before an MR is opened; no CI pipeline within 60s ends the run; polling gives up after 2 hours; fix attempts stop at `maxFixAttempts`; a fix that changes no files, or a `canceled`/`skipped` pipeline, escalates immediately. Escalation always leaves a comment on the MR/PR.

## License

[MIT](LICENSE)
