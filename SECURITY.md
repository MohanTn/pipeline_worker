# Security Policy

## Supported versions

Only the latest published version of `pipeline-worker` receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead:

- Use [GitHub private vulnerability reporting](https://github.com/MohanTn/pipeline-worker/security/advisories/new), or
- Email **mohan.tn100@gmail.com** with a description and reproduction steps.

You can expect an acknowledgement within a few days. Please allow time for a fix to be released before public disclosure.

## Scope notes for users

- pipeline-worker executes a coding agent with auto-accept permissions inside a disposable git worktree, and pushes commits to your forge. Run it only in repos you trust and with tokens scoped to that repo.
- Forge tokens are read exclusively from environment variables / a git-ignored `.env` file. If you find any code path that logs or persists a token, that is a vulnerability — please report it.
