# src/forge — conventions

Moved here from the root CLAUDE.md (check 4 of `/doctor`): only relevant when touching this directory.

- `listMrComments` is the one place GitHub needs GraphQL for reading: REST's `/pulls/{n}/comments` says nothing about whether a review thread was **resolved**, so review threads come from the `reviewThreads` query and only PR-level (issue) comments come from REST. A GitHub PR-level comment cannot be replied to *under* — `replyToComment` posts a new top-level comment for it, which is why `MrComment.threadable` exists. GitLab has neither problem: every note lives in a discussion, and every discussion takes notes.
- `src/forge/github.ts` is adopted by the boilerplate generator (it carries `// scaffold:inject` at module scope and `// scaffold:inject-client` inside `createGithubForge`'s returned object). New members there must come from `scaffold.js --template member --inject`; a hand-written one is blocked by the pre-tool-use guard.

- The GitLab forge (`src/forge/gitlab.ts`) integrates with GitLab through the `glab` CLI (`glab api ...`): it authenticates non-interactively by passing `GITLAB_TOKEN` and `--hostname` to the child process, reading `gitlab.host`/`gitlab.token` from the settings file. The GitHub forge (`src/forge/github.ts`) instead calls GitHub's REST/GraphQL API directly via `fetch`. `glab` must be installed and on `PATH` wherever `"forge": "gitlab"` runs. There is no pipeline-worker-owned MCP server (removed): a CI-fix agent turn is told to use the forge's own CLI (`glab`/`gh`) directly, via full shell access on that turn.
