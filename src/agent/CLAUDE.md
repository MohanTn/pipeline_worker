# src/agent — conventions

Moved here from the root CLAUDE.md (check 4 of `/doctor`): only relevant when touching this directory.

- Agent turns are scoped, not trusted: each `agent.invoke` passes a one-sentence `systemPrompt` and, unless the turn legitimately needs a shell (CI fix / local check fix), an `allowedTools` list. The claude adapter turns that list into `--tools` (which built-ins exist) *and* `--allowedTools` (which run unprompted), so a read-only turn has no shell to ask for. Intent = `['Read']` with the `git diff` patch embedded in the prompt by pipeline-worker (capped, so a lockfile can't swamp the context), conflicts = `['Read','Write','Edit']`, review = `['Read']` working from the diff in its prompt. `config.bareAgentMode` adds `--bare`; it forces API-key-only auth, hence the load-time warning.
- Agent CLI flags must be verified against the installed CLI before use (`claude --help`), and the module comment records which ones were. `little-coder` is pi plus extensions, so it takes pi's flags; its adapter also trims every prompt to `littleCoder.maxPromptChars` for small local contexts.
