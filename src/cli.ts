#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { ensureLatestVersion, installVersion } from './version/autoUpdate.js';
import { runWorkflow } from './workflow/orchestrate.js';
import { watchPipeline } from './workflow/watchPipeline.js';
import { startServer } from './mcp/server.js';
import { loadConfig } from './config/loader.js';
import { createForge } from './forge/index.js';
import { selectAgent } from './agent/index.js';
import { loadRunState, listRunStates, recordEvent } from './state/runState.js';
import { findRepoRoot } from './git/commit.js';
import { printSessionList, printSessionDetail } from './ui/sessions.js';
import { isWorktreeOnBranch, checkoutExistingBranch, removeWorktree } from './git/worktree.js';
import { remoteBranchExists } from './git/remote.js';
import { adoptBranch, resolveResumeMode } from './workflow/adoptBranch.js';
import { maybeSyncTargetBranch } from './workflow/syncTargetBranch.js';
import { maybeReviewMergeRequest } from './workflow/reviewMr.js';
import { resumeSkeleton, adoptSkeleton, reviewSkeleton } from './workflow/runPlan.js';
import { beginRun, endRun, runStep, seedRunTokens } from './ui/steps.js';
import { setCompletionSound } from './ui/notify.js';
import { buildEnvelope, errorEnvelope } from './toon/envelope.js';
import { makeIdempotentCleanup, registerExitSignals } from './process/signalCleanup.js';
import type { ForgeClient } from './forge/types.js';
import type { AgentAdapter } from './agent/types.js';
import type { PipelineWorkerConfig, ResumableRunState } from './types.js';

/**
 * Adoption works off the branch as origin has it (see
 * git/worktree.ts's checkoutExistingBranch), so a branch that was never
 * pushed — a run that died before its push, leaving only a state file — has
 * nothing to adopt. Caught here to say so plainly, rather than surfacing a
 * raw `git fetch` failure.
 */
async function requirePushedBranch(repoRoot: string, branch: string): Promise<void> {
  if (await remoteBranchExists(repoRoot, branch)) return;
  console.error(
    `pipeline-worker: branch ${branch} does not exist on origin — there is nothing to resume or adopt. ` +
      'Re-run `pipeline-worker run` from your changes instead.',
  );
  process.exit(1);
}

/**
 * The worktree from the crashed run is almost always already gone by this
 * point (orchestrate.ts's `finally` removes it on any exception, and on
 * SIGINT/SIGTERM) — reuse it only in the narrow case it survived (e.g. a
 * SIGKILL), otherwise recreate it from the branch's current state on origin.
 */
async function resolveResumeWorktree(repoRoot: string, state: ResumableRunState): Promise<string> {
  const worktreePath = (await isWorktreeOnBranch(state.worktreePath, state.branch))
    ? state.worktreePath
    : await checkoutExistingBranch(repoRoot, state.branch);
  if (worktreePath !== state.worktreePath) {
    state.worktreePath = worktreePath;
    recordEvent(repoRoot, state, `Recreated worktree at ${worktreePath}`);
  }
  return worktreePath;
}

async function runResumeWatch(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  state: ResumableRunState,
  repoRoot: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await watchPipeline(forge, config, agent, worktreePath, state.branch, state.targetBranch, state.mrIid, state, repoRoot);
    // Same 'merge' tail as a fresh run (see orchestrate.ts's finalizeRun):
    // when auto-merge landed the MR/PR, pull the merged result back into the
    // local target branch so it doesn't sit stale after the run ends.
    if (state.phase === 'done') {
      await maybeSyncTargetBranch(forge, config, repoRoot, state.targetBranch, state.mrIid);
      endRun('done', `MR/PR #${state.mrIid} finished green`);
    } else if (state.phase === 'escalated') {
      endRun('escalated', 'see the MR/PR comment for what was tried and why');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordEvent(repoRoot, state, `Resume failed: ${message}`, 'error');
    endRun('failed', message);
    throw error;
  } finally {
    await cleanup();
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { name: string; version: string };

const program = new Command();

program.name('pipeline-worker').description('Automated git-worktree -> agent-fix -> GitLab/GitHub MR workflow');
program.version(pkg.version, '-v, --version', 'output the installed pipeline-worker version');

program
  .command('run', { isDefault: true })
  .description('Capture the current diff, validate it, and drive it through to a green MR/PR')
  .option('--ticket <id>', 'ticket/issue id to interpolate into the configured branchPattern\'s {ticket} placeholder')
  .option('--target <branch>', "base branch for the MR/PR (default: origin's default branch, main or master)")
  .action(async (opts: { ticket?: string; target?: string }) => {
    try {
      await ensureLatestVersion(pkg.name, pkg.version);
      const repoRoot = await findRepoRoot(process.cwd());
      await runWorkflow(repoRoot, { ticket: opts.ticket, target: opts.target });
    } catch (error) {
      console.error('pipeline-worker run failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start the pipeline-worker forge (GitLab/GitHub) MCP server over stdio')
  .action(async () => {
    try {
      await startServer();
    } catch (error) {
      console.error('Failed to start MCP server:', error);
      process.exit(1);
    }
  });

program
  .command('resume')
  .description(
    'Resume watching/fixing a previously started run after a crash, or adopt a branch whose run never got as far as ' +
      'opening a PR/MR — including one pipeline-worker has no record of at all (checks the forge for an open PR/MR and ' +
      'either opens one or refreshes its description before watching CI)',
  )
  .requiredOption('--branch <name>', 'branch name of the run to resume or adopt')
  .option(
    '--target <branch>',
    "base branch for a newly opened PR/MR when adopting a branch with no existing one (default: origin's auto-detected default branch)",
  )
  .action(async (opts: { branch: string; target?: string }) => {
    try {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = loadConfig(repoRoot);
      setCompletionSound(config.completionSound);
      const forge = createForge(config);
      const agent = selectAgent(config);

      const mode = resolveResumeMode(loadRunState(repoRoot, opts.branch), opts.target);
      let state: ResumableRunState;
      let worktreePath: string;
      if (mode.kind === 'resume') {
        beginRun(resumeSkeleton(mode.state.targetBranch), { title: opts.branch });
        if (mode.state.totalTokens !== undefined) seedRunTokens(mode.state.totalTokens);
        worktreePath = await runStep('resume', 'reattach: reuse the crashed run\'s worktree, or recreate it from origin', () =>
          resolveResumeWorktree(repoRoot, mode.state),
        );
        state = mode.state;
      } else {
        await requirePushedBranch(repoRoot, opts.branch);
        beginRun(adoptSkeleton(opts.branch), { title: opts.branch });
        state = await adoptBranch(repoRoot, config, forge, agent, opts.branch, mode.target, mode.reason);
        worktreePath = state.worktreePath;
        // Adoption is the one resume path that just (re)opened an MR/PR, so
        // it is the one that has something new to review; a resumed run's
        // MR/PR was already reviewed when its original run opened it.
        await maybeReviewMergeRequest(forge, config, agent, worktreePath, state.targetBranch, state.mrIid);
      }

      const { cleanup } = makeIdempotentCleanup(() => removeWorktree(repoRoot, worktreePath));
      registerExitSignals((exitCode) => {
        endRun('interrupted', `resume again with: pipeline-worker resume --branch ${opts.branch}`);
        void cleanup().then(() => process.exit(exitCode));
      });

      await runResumeWatch(forge, config, agent, worktreePath, state, repoRoot, cleanup);
      console.log(`pipeline-worker: resumed run finished with phase "${state.phase}".`);
    } catch (error) {
      console.error('pipeline-worker resume failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('review')
  .description("Review an open MR/PR's diff with the configured agent and post line-anchored comments on it (nothing else — no checks, no CI watch)")
  .requiredOption('--branch <name>', 'branch whose open MR/PR should be reviewed')
  .action(async (opts: { branch: string }) => {
    try {
      const repoRoot = await findRepoRoot(process.cwd());
      const config = loadConfig(repoRoot);
      setCompletionSound(config.completionSound);
      const forge = createForge(config);
      const agent = selectAgent(config);

      const mr = await forge.findExistingMr(opts.branch);
      if (!mr) {
        console.error(`pipeline-worker: no open MR/PR found for branch ${opts.branch} — open one first (pipeline-worker resume --branch ${opts.branch}).`);
        process.exit(1);
      }

      beginRun(reviewSkeleton(opts.branch), { title: opts.branch });
      const worktreePath = await runStep('adopt', `checkout ${opts.branch} into a disposable worktree`, () =>
        checkoutExistingBranch(repoRoot, opts.branch),
      );
      try {
        // Asking for a review explicitly *is* the opt-in, so config.review is
        // overridden here — PIPELINE_WORKER_REVIEW only gates the automatic
        // stage inside `run`/`resume`.
        const posted = await maybeReviewMergeRequest(forge, { ...config, review: true }, agent, worktreePath, mr.targetBranch, mr.iid);
        endRun('done', posted > 0 ? `posted ${posted} comment(s) on ${mr.webUrl}` : `nothing worth commenting on — ${mr.webUrl}`);
      } finally {
        await removeWorktree(repoRoot, worktreePath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      endRun('failed', message);
      console.error('pipeline-worker review failed:', message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Print the persisted state of a run')
  .requiredOption('--branch <name>', 'branch name of the run to inspect')
  .action((opts: { branch: string }) => {
    const repoRoot = process.cwd();
    const state = loadRunState(repoRoot, opts.branch);
    if (!state) {
      console.log(errorEnvelope('not_found', `no run state found for branch ${opts.branch}`));
      return;
    }
    console.log(buildEnvelope({ status: 'success', data: state }));
  });

program
  .command('sessions')
  .description("List this repo's persisted pipeline-worker runs, or inspect one run's full timeline")
  .option('--branch <name>', 'show the full step-by-step timeline for one run instead of listing all')
  .action((opts: { branch?: string }) => {
    const repoRoot = process.cwd();
    if (opts.branch) {
      const state = loadRunState(repoRoot, opts.branch);
      if (!state) {
        console.error(`pipeline-worker: no session found for branch ${opts.branch}.`);
        process.exit(1);
      }
      printSessionDetail({ branch: state.branch, state });
      return;
    }
    printSessionList(listRunStates(repoRoot));
  });

program
  .command('update')
  .description(`Install the latest ${pkg.name} release from npm (npm install -g ${pkg.name}@latest)`)
  .action(async () => {
    console.log(`pipeline-worker: currently v${pkg.version}, installing latest via npm install -g ${pkg.name}@latest ...`);
    try {
      await installVersion(pkg.name, 'latest');
    } catch (error) {
      console.error('pipeline-worker update failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    console.log(`pipeline-worker: updated — run "${pkg.name} -v" to confirm the installed version.`);
  });

program.addHelpText(
  'after',
  `
Examples:
  $ pipeline-worker run
      Capture your uncommitted changes and drive them to a green MR/PR, targeting
      origin's default branch (main or master). If the branch you are on already has
      an open MR/PR, the change is committed onto it and its description gains a
      file-wise breakdown of this follow-up instead of a new MR/PR being opened.

  $ pipeline-worker run --ticket PROJ-123
      Same, but interpolate PROJ-123 into the configured branchPattern.

  $ pipeline-worker run --target release/2.0
      Same, but open the MR/PR against release/2.0 instead of the default branch.

  $ pipeline-worker resume --branch pipeline-worker/add-login
      Resume watching/fixing a previously started run after a crash.

  $ pipeline-worker resume --branch pipeline-worker/add-login
      Also the recovery for a run that pushed its branch and then died before
      the PR/MR existed (the forge was down, the process was killed): the branch
      is adopted as origin has it and a PR/MR is opened for it, reusing the dead
      run's target branch unless you pass --target.

  $ pipeline-worker resume --branch some-branch-you-pushed-by-hand
      Adopt a branch pipeline-worker never ran on: open a PR/MR against origin's
      default branch if none exists yet, or refresh an existing one's description
      and resume watching its CI. Pass --target <branch> to override the base branch.

  $ pipeline-worker review --branch pipeline-worker/add-login
      Review that branch's open MR/PR with the configured agent and post
      line-anchored comments (with one-click \`\`\`suggestion fixes) on the lines
      it flags. Runs regardless of PIPELINE_WORKER_REVIEW, which only gates the
      automatic review inside \`run\`/\`resume\`.

  $ pipeline-worker status --branch pipeline-worker/add-login
      Print the persisted state of that run.

  $ pipeline-worker sessions
      List this repo's persisted runs.

  $ pipeline-worker sessions --branch pipeline-worker/add-login
      Show the full step-by-step timeline for that one run.

  $ pipeline-worker serve
      Start the forge MCP server over stdio (used internally by coding agents).

  $ pipeline-worker update
      Install the latest pipeline-worker release from npm.
`,
);

program.parseAsync(process.argv).catch((error) => {
  console.error('pipeline-worker: unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
