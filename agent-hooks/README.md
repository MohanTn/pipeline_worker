# agent-hooks

Auto-triggers `pipeline-worker run` in the background as soon as an agent turn ends leaving uncommitted changes in a repo — no manual `pipeline-worker` invocation needed after each feature. Both integrations share the same logic in `claude/hooks/on-stop.mjs`, which no-ops silently unless there are uncommitted changes and no run already in progress (see `PIPELINE_WORKER_CLEANUP_EARLY` in the main README for freeing the repo up for the *next* feature before this one's CI finishes).

## Claude Code

Install the plugin at user scope so it applies in every repo:

```sh
claude plugin install /home/mohan/REPO/pipeline_worker/agent-hooks/claude
```

## GitHub Copilot CLI

Copy (or symlink) the hooks config into Copilot's global hooks directory:

```sh
mkdir -p ~/.copilot/hooks
cp /home/mohan/REPO/pipeline_worker/agent-hooks/copilot/pipeline-worker-trigger.json ~/.copilot/hooks/
```

Its `command` field hard-codes the absolute path to `on-stop.mjs` — Copilot's hook schema has no documented `${CLAUDE_PLUGIN_ROOT}`-style path variable, so update that path if this repo ever moves.

## Notes

- Both agents fire this hook after *every* turn, not specifically "the feature is done" — the git-status and lock-file checks make repeated firing harmless, but a mid-feature turn that happens to leave the tree dirty can trigger a premature handoff. There's no finer-grained "feature complete" signal in either tool today.
- `pipeline-worker` must be on `PATH` for the spawn to succeed; if it's missing, the hook exits quietly.
