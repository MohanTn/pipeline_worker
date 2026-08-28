# Intent-capture eval

Regression eval for the intent-capture turn (`src/workflow/captureIntent.ts` —
the step that reads a diff and returns `changeType`/`risk`/`commitMessage`/
`summary` as validated JSON). It exists because Zod already guarantees the
*shape* of that JSON at runtime; this eval checks the *content* — did it pick
the right change type, is the risk level calibrated, does the summary
actually match the diff — which a schema can't catch and which only shows up
as a quality regression when the prompt in `captureIntent.ts` or
`agent/promptText.ts` changes.

Each test case builds a real temp git repo (`eval/fixtures.mjs`) with one
committed base state and an uncommitted change on top — the same shape a
real run's worktree has — and runs the actual `captureIntent()` against the
real `claude` CLI adapter, so this exercises the exact production code path,
not a re-implemented copy of the prompt.

## Run it

```sh
npm run eval:intent
```

Requires:

- `npm run build` (the eval script runs this first) — the provider imports
  from `dist/`, not `src/`.
- The `claude` CLI installed and authenticated, same as running
  pipeline-worker itself.
- `ANTHROPIC_API_KEY` set, for the `llm-rubric` assertions only — promptfoo's
  built-in grading providers call the API directly rather than going through
  a CLI login, unlike the intent-capture provider itself.

## Adding a scenario

Add an entry to `SCENARIOS` in `eval/fixtures.mjs` (base files, then
changed/added files left uncommitted) and a matching `tests:` entry in
`promptfooconfig.yaml`. Prefer scenarios where the expected classification is
inferable from the diff alone — the model only sees the diff and the file
list, not the rest of the repo.

## What this doesn't cover

MR/PR review and CI-fix are not evaluated here: review is a "did it catch a
known issue" problem better suited to mutation-style fixtures, and CI-fix is
an agentic loop best measured by production outcome telemetry (fix success
rate, attempts before escalation), not an offline prompt eval.
