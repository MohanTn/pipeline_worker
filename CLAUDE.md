# pipeline-worker — working conventions

Read this before changing anything. It records the contracts that are not visible from any single file.

## Release pipeline (the most important constraint)

Every merge to `main` auto-publishes: CI runs build, lint, test on Node 22 and 24, then the publish job bumps the **patch** version, pushes the tag, and publishes to npm (`.github/workflows/ci.yml`). There is no manual release step and no minor/major bump path.

Consequences:

- Every merge must be shippable on its own. Do not merge half of a feature.
- Behavior changes ship under a patch bump, so the `CHANGELOG.md` entry must carry the weight: mark behavior changes prominently.
- Commit messages on `main` matter; `[skip ci]` is reserved for the release bot's own version commit.

## Code conventions

- TypeScript ESM (`"type": "module"`), Node >= 20.12. Imports use `.js` extensions.
- Configuration is one JSON file only — `~/.config/pipeline-worker/config.json` (`$XDG_CONFIG_HOME` honored), read by `src/config/file.ts` and parsed once in `src/config/loader.ts`, which creates it with the defaults on first run. No environment variables (`PIPELINE_WORKER_*` are gone, and `.env` is no longer read), no per-repo config file, no CLI flags for settings. Per-repo values (`github.repo`, `gitlab.projectId`, `build`/`lint`/`test`) stay auto-detected from the repo unless the file names them. Tests point `XDG_CONFIG_HOME` at a temp dir instead of setting env vars.
- Runtime dependencies are deliberately minimal (commander + zod + toon). Do not add a dependency for something ~150 lines of hand-rolled code covers.
- The GitLab forge (`src/forge/gitlab.ts`) integrates with GitLab through the `glab` CLI (`glab api ...`): it authenticates non-interactively by passing `GITLAB_TOKEN` and `--hostname` to the child process, reading `gitlab.host`/`gitlab.token` from the settings file. The GitHub forge (`src/forge/github.ts`) instead calls GitHub's REST/GraphQL API directly via `fetch`. `glab` must be installed and on `PATH` wherever `"forge": "gitlab"` runs. There is no pipeline-worker-owned MCP server (removed): a CI-fix agent turn is told to use the forge's own CLI (`glab`/`gh`) directly, via full shell access on that turn.
- Agent turns are scoped, not trusted: each `agent.invoke` passes a one-sentence `systemPrompt` and, unless the turn legitimately needs a shell (CI fix / local check fix), an `allowedTools` list. The claude adapter turns that list into `--tools` (which built-ins exist) *and* `--allowedTools` (which run unprompted), so a read-only turn has no shell to ask for. Intent = `['Read']` with the `git diff` patch embedded in the prompt by pipeline-worker (capped, so a lockfile can't swamp the context), conflicts = `['Read','Write','Edit']`, review = `['Read']` working from the diff in its prompt. `config.bareAgentMode` adds `--bare`; it forces API-key-only auth, hence the load-time warning.
- Agent CLI flags must be verified against the installed CLI before use (`claude --help`), and the module comment records which ones were. `little-coder` is pi plus extensions, so it takes pi's flags; its adapter also trims every prompt to `littleCoder.maxPromptChars` for small local contexts.
- Errors are plain `Error` with labeled messages, not typed error classes. Best-effort vs fatal is decided by where the try/catch sits.

## Never-throw contracts

- **State layer** (`src/state/runState.ts`): load/save never throw; failures degrade to a `console.error` warning. A corrupt state file reads as "no state".
- **UI layer** (`src/ui/`): rendering must never kill the workflow. Unknown step ids, width edge cases, and formatting failures are warnings, not exceptions.
- **Best-effort stages** (squash, target-branch sync, version auto-update): any failure is reduced to a note; the run's outcome is unchanged.

## Terminal output discipline

Only code under `src/ui/` may write to `process.stdout` directly. Everything else goes through the functions exported by `src/ui/steps.ts` (`runStep`, `step`, `skipStep`, `note`, ...). This keeps the live TTY renderer's console interception airtight: a stray `process.stdout.write` elsewhere corrupts the redraw region.

## Tests

- `node:test` + `node:assert/strict`, run via tsx (`npm test`). No mocking libraries.
- GitHub forge/HTTP code is tested against a real local `http.createServer` stub. GitLab forge code is tested by injecting a fake `GlabExecutor` (see `createGitlabForge`'s second argument) that asserts on the `glab` argv/stdin it would have received — no real `glab` binary needed for `npm test`.
- Workflow code is tested with hand-written stub objects implementing `ForgeClient` / `AgentAdapter`.
- Git-touching code is tested against real throwaway repos (`mkdtempSync` + `git init`, bare origin where needed), cleaned up in `finally`.
- `test/cli.test.ts` exercises the built `dist/cli.js`, so run `npm run build` before `npm test` when touching the CLI.
- Every code change ships with unit tests in the same commit.

## Gates

`npm run build && npm run lint && npm test` must pass before any commit.
