/**
 * Best-effort readiness for whatever the target repo's pre-commit hook needs
 * to actually run. A fresh worktree checks out the repo's tracked hook
 * scripts (.husky/*, .config/dotnet-tools.json) but not the *installed*
 * state behind them: npm-managed husky needs its "prepare" script re-run to
 * point core.hooksPath at this worktree, and a dotnet local-tool manifest
 * (Husky.Net, CSharpier, ...) needs `dotnet tool restore` before the tool
 * shims it declares actually exist. Left undone, the hook fails with
 * "command not found" rather than a real lint/build problem — and unlike the
 * auto-fix case git/commit.ts's commit() already retries (a hook that
 * rewrites files and fails), a missing-tool failure leaves the tree
 * untouched, so it isn't retried and just aborts the run.
 *
 * Every step here swallows its own error and logs a warning instead of
 * throwing — same never-throw contract as worktree.ts's linkNodeModules and
 * the other best-effort stages (squash, target-branch sync): a broken or
 * absent toolchain degrades to "the hook runs unprepared", never to a failed
 * pipeline-worker run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when package.json declares a "prepare" script — the standard hook husky's own installer wires up (`husky` or `husky install`). */
function hasNpmPrepareScript(worktreePath: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(worktreePath, 'package.json'), 'utf-8')).scripts;
    return typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).prepare === 'string';
  } catch {
    return false;
  }
}

/** Re-runs npm's "prepare" script so husky points core.hooksPath at this worktree's .husky directory. No-op when the repo shows no sign of using husky. */
async function ensureHuskyInstalled(worktreePath: string): Promise<void> {
  if (!existsSync(join(worktreePath, '.husky')) || !hasNpmPrepareScript(worktreePath)) return;
  try {
    await execFileAsync('npm', ['run', 'prepare'], { cwd: worktreePath });
  } catch (error) {
    console.error(`Warning: "npm run prepare" (husky setup) failed in ${worktreePath}: ${errorMessage(error)}`);
  }
}

/** Restores dotnet local tools (Husky.Net, CSharpier, ...) declared in .config/dotnet-tools.json, so the pre-commit hook's own tool invocations resolve. No-op when the repo has no local-tool manifest. */
async function ensureDotnetToolsRestored(worktreePath: string): Promise<void> {
  if (!existsSync(join(worktreePath, '.config', 'dotnet-tools.json'))) return;
  try {
    await execFileAsync('dotnet', ['tool', 'restore'], { cwd: worktreePath });
  } catch (error) {
    console.error(`Warning: "dotnet tool restore" failed in ${worktreePath}: ${errorMessage(error)}`);
  }
}

/**
 * Gets whatever pre-commit tooling the worktree declares ready, before the
 * first commit() call against it. Called once per worktree, right after
 * linkNodeModules (see worktree.ts), so it covers every commit() call site
 * regardless of which stage makes it (a fresh run's own commit, a
 * changelog-only commit on an adopted branch, a CI-fix or
 * conflict-resolution commit). Never throws.
 */
export async function prepareCommitHooks(worktreePath: string): Promise<void> {
  await ensureHuskyInstalled(worktreePath);
  await ensureDotnetToolsRestored(worktreePath);
}
