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
- Configuration is env-vars only (`PIPELINE_WORKER_*`), parsed once in `src/config/loader.ts`. No config files, no CLI flags for settings.
- Runtime dependencies are deliberately minimal (commander + MCP SDK + toon). Do not add a dependency for something ~150 lines of hand-rolled code covers.
- The GitLab forge (`src/forge/gitlab.ts`) integrates with GitLab through the `glab` CLI (`glab api ...`): it authenticates non-interactively by passing `GITLAB_TOKEN` and `--hostname` to the child process, using the same `PIPELINE_WORKER_GITLAB_*` config as before. The GitHub forge (`src/forge/github.ts`) instead calls GitHub's REST/GraphQL API directly via `fetch`. `glab` must be installed and on `PATH` wherever `PIPELINE_WORKER_FORGE=gitlab` runs.
- Errors are plain `Error` with labeled messages, not typed error classes. Best-effort vs fatal is decided by where the try/catch sits.

## Never-throw contracts

- **State layer** (`src/state/runState.ts`): load/save never throw; failures degrade to a `console.error` warning. A corrupt state file reads as "no state".
- **UI layer** (`src/ui/`): rendering must never kill the workflow. Unknown step ids, width edge cases, and formatting failures are warnings, not exceptions.
- **Best-effort stages** (squash, target-branch sync, version auto-update): any failure is reduced to a note; the run's outcome is unchanged.

## Terminal output discipline

Only code under `src/ui/` may write to `process.stdout` directly. Everything else goes through the functions exported by `src/ui/steps.ts` (`runStep`, `step`, `skipStep`, `note`, ...). This keeps the live TTY renderer's console interception airtight: a stray `process.stdout.write` elsewhere corrupts the redraw region.

## Tests

- `node:test` + `node:assert/strict`, run via tsx (`npm test`). No mocking libraries.
- GitHub forge/HTTP code is tested against a real local `http.createServer` stub. GitLab forge code is tested by injecting a fake `GlabExecutor` (see `createGitlabForge`'s second argument) that asserts on the `glab` argv/stdin it would have received — no real `glab` binary needed for `npm test`. `test/cli.test.ts`'s GitLab-touching case additionally stands up a throwaway `glab` shell script on `PATH` (see `writeFakeGlab`) since that test spawns the compiled CLI as a real subprocess and can't inject at the TS level.
- Workflow code is tested with hand-written stub objects implementing `ForgeClient` / `AgentAdapter`.
- Git-touching code is tested against real throwaway repos (`mkdtempSync` + `git init`, bare origin where needed), cleaned up in `finally`.
- `test/cli.test.ts` exercises the built `dist/cli.js`, so run `npm run build` before `npm test` when touching the CLI.
- Every code change ships with unit tests in the same commit.

## Gates

`npm run build && npm run lint && npm test` must pass before any commit.
