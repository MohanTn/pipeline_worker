# src/forge — conventions

Moved here from the root CLAUDE.md (check 4 of `/doctor`): only relevant when touching this directory.

- The GitLab forge (`src/forge/gitlab.ts`) integrates with GitLab through the `glab` CLI (`glab api ...`): it authenticates non-interactively by passing `GITLAB_TOKEN` and `--hostname` to the child process, reading `gitlab.host`/`gitlab.token` from the settings file. The GitHub forge (`src/forge/github.ts`) instead calls GitHub's REST/GraphQL API directly via `fetch`. `glab` must be installed and on `PATH` wherever `"forge": "gitlab"` runs. There is no pipeline-worker-owned MCP server (removed): a CI-fix agent turn is told to use the forge's own CLI (`glab`/`gh`) directly, via full shell access on that turn.
