#!/usr/bin/env node
import { Command } from 'commander';
import { runWorkflow } from './workflow/orchestrate.js';
import { watchPipeline } from './workflow/watchPipeline.js';
import { startServer } from './mcp/server.js';
import { loadConfig } from './config/loader.js';
import { createForge } from './forge/index.js';
import { selectAgent } from './agent/index.js';
import { loadRunState } from './state/runState.js';
import { buildEnvelope, errorEnvelope } from './toon/envelope.js';

const program = new Command();

program.name('pipeline-worker').description('Automated git-worktree -> agent-fix -> GitLab/GitHub MR workflow');

program
  .command('run', { isDefault: true })
  .description('Capture the current diff, validate it, and drive it through to a green MR/PR')
  .action(async () => {
    try {
      await runWorkflow(process.cwd());
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
      await watchPipeline(forge, config, agent, state.worktreePath, state.branch, state.targetBranch, state.mrIid, state, repoRoot);
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

program.parseAsync(process.argv).catch((error) => {
  console.error('pipeline-worker: unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
