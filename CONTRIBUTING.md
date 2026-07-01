# Contributing to pipeline-worker

Thanks for helping out! Issues and pull requests are welcome.

## Development setup

```sh
git clone https://github.com/MohanTn/pipeline-worker.git
cd pipeline-worker
npm ci
npm run build   # tsc -> dist/ (test/cli.test.ts exercises the compiled CLI)
npm run lint
npm test
```

Node.js >= 20.12 is required.

## Making changes

- Open an issue first for anything larger than a small fix, so the approach can be agreed before you invest time.
- Keep PRs focused: one logical change per PR.
- Add or update tests for behavior you change (`test/*.test.ts`, `node:test` runner).
- `npm run build && npm run lint && npm test` must pass — CI runs exactly these.
- Use a conventional-commit-style title (`fix: …`, `feat: …`, `docs: …`); it becomes the squash commit message.

## Design ground rules

- The caller's working tree is sacred: all workflow steps run in a disposable worktree.
- Tokens come from environment variables only — never from YAML config, never logged.
- Agent CLI flags must be verified against the installed CLI or official docs before use; don't guess (see `src/agent/*.ts`).
- Every retry loop must be bounded (`maxFixAttempts`, the polling window). Never retry indefinitely.
- Agent tokens are a budget: don't add agent invocations where a plain API call will do.

## Releasing (maintainers)

Bump `version` in `package.json` in the PR. On merge to `main`, CI publishes to npm automatically (with provenance) if that version isn't already published; merges without a version bump publish nothing.
