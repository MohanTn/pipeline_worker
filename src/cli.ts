#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Command } from 'commander';
import { ensureLatestVersion, installVersion } from './version/autoUpdate.js';
import { runWorkflow } from './workflow/orchestrate.js';
import { resumeRun, reviewBranch } from './workflow/runCommands.js';
import { loadRunState, listRunStates } from './state/runState.js';
import { findRepoRoot } from './git/commit.js';
import { printSessionList, printSessionDetail } from './ui/sessions.js';
import { startTui, shouldOpenTui } from './ui/tui/index.js';
import { endRun } from './ui/steps.js';
import { buildEnvelope, errorEnvelope } from './toon/envelope.js';

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
      // `run` is the default command, so this action also receives a bare
      // `pipeline-worker`; on an interactive terminal that means the TUI.
      if (shouldOpenTui(process.argv.slice(2), process.stdin.isTTY === true, process.stdout.isTTY === true)) {
        await startTui(repoRoot);
        return;
      }
      await runWorkflow(repoRoot, { ticket: opts.ticket, target: opts.target });
    } catch (error) {
      console.error('pipeline-worker run failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('tui')
  .description('Open the full-screen interactive dashboard: start runs, browse sessions, edit every setting, and walk through first-time setup')
  .action(async () => {
    try {
      const repoRoot = await findRepoRoot(process.cwd());
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        console.error('pipeline-worker: the TUI needs an interactive terminal — use `pipeline-worker run` (or the other subcommands) when output is redirected.');
        process.exit(1);
      }
      await startTui(repoRoot);
    } catch (error) {
      console.error('pipeline-worker tui failed:', error instanceof Error ? error.message : error);
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
      const phase = await resumeRun(repoRoot, { branch: opts.branch, target: opts.target });
      console.log(`pipeline-worker: resumed run finished with phase "${phase}".`);
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
      await reviewBranch(repoRoot, { branch: opts.branch });
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
  $ pipeline-worker
      On an interactive terminal, opens the TUI (same as \`pipeline-worker tui\`).
      With any argument, or when stdin/stdout is redirected, behaves as \`run\`.

  $ pipeline-worker tui
      Full-screen dashboard: start a run, browse this repo's sessions and resume
      or review one, edit every setting with an explanation of what it does, or
      walk the setup guide. Start here on a new machine.

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

  $ pipeline-worker update
      Install the latest pipeline-worker release from npm.
`,
);

program.parseAsync(process.argv).catch((error) => {
  console.error('pipeline-worker: unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
