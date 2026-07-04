#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { runWorkflow } from './workflow/orchestrate.js';
import { watchPipeline } from './workflow/watchPipeline.js';
import { startServer } from './mcp/server.js';
import { loadConfig } from './config/loader.js';
import { createForge } from './forge/index.js';
import { selectAgent } from './agent/index.js';
import { loadRunState, listRunStates, recordEvent } from './state/runState.js';
import { printSessionList, printSessionDetail } from './ui/sessions.js';
import { isWorktreeOnBranch, checkoutExistingBranch, removeWorktree } from './git/worktree.js';
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
  .action(async (opts: { ticket?: string }) => {
    try {
      await runWorkflow(process.cwd(), { ticket: opts.ticket });
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
  .description('Resume watching/fixing a previously started run after a crash')
  .requiredOption('--branch <name>', 'branch name of the run to resume')
  .action(async (opts: { branch: string }) => {
    try {
      const repoRoot = process.cwd();
      const state = loadRunState(repoRoot, opts.branch);
      if (!state || state.mrIid === undefined) {
        console.error(`pipeline-worker: no resumable run found for branch ${opts.branch} (no merge request recorded yet).`);
        process.exit(1);
      }
      const config = loadConfig(repoRoot);
      const forge = createForge(config);
      const agent = selectAgent(config);

      // The worktree from the crashed run is almost always already gone by
      // this point (orchestrate.ts's `finally` removes it on any exception,
      // and on SIGINT/SIGTERM) — reuse it only in the narrow case it
      // survived (e.g. a SIGKILL), otherwise recreate it from the branch's
      // current state on origin.
      const worktreePath = (await isWorktreeOnBranch(state.worktreePath, state.branch))
        ? state.worktreePath
        : await checkoutExistingBranch(repoRoot, state.branch);
      if (worktreePath !== state.worktreePath) {
        state.worktreePath = worktreePath;
        recordEvent(repoRoot, state, `Recreated worktree at ${worktreePath}`);
      }

      let cleanedUp = false;
      const cleanup = async (): Promise<void> => {
        if (cleanedUp) return;
        cleanedUp = true;
        await removeWorktree(repoRoot, worktreePath);
      };
      const onSignal = (exitCode: number) => {
        void cleanup().then(() => process.exit(exitCode));
      };
      process.once('SIGINT', () => onSignal(130));
      process.once('SIGTERM', () => onSignal(143));

      try {
        await watchPipeline(forge, config, agent, worktreePath, state.branch, state.targetBranch, state.mrIid, state, repoRoot);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordEvent(repoRoot, state, `Resume failed: ${message}`, 'error');
        throw error;
      } finally {
        await cleanup();
      }
      console.log(`pipeline-worker: resumed run finished with phase "${state.phase}".`);
    } catch (error) {
      console.error('pipeline-worker resume failed:', error instanceof Error ? error.message : error);
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
      await new Promise<void>((resolve, reject) => {
        // stdio: 'inherit' streams npm's own progress/errors straight to the
        // user's terminal rather than buffering it — an install can take a
        // while and users expect to see npm's usual output live.
        const npm = spawn('npm', ['install', '-g', `${pkg.name}@latest`], { stdio: 'inherit' });
        npm.on('error', reject);
        npm.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
      });
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
      Capture your uncommitted changes and drive them to a green MR/PR.

  $ pipeline-worker run --ticket PROJ-123
      Same, but interpolate PROJ-123 into the configured branchPattern.

  $ pipeline-worker resume --branch pipeline-worker/add-login
      Resume watching/fixing a previously started run after a crash.

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
