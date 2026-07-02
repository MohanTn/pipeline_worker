/** Top-level control flow wiring the user's 8-step workflow together. */

import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import { selectAgent } from '../agent/index.js';
import { captureDiff } from '../git/diff.js';
import { createWorktree, applyDiffToWorktree, removeWorktree, renameBranch, generateTempBranchName } from '../git/worktree.js';
import { currentBranch, commit } from '../git/commit.js';
import { captureIntent } from './captureIntent.js';
import { runChecks } from './runChecks.js';
import { openMergeRequest } from './openMergeRequest.js';
import { watchPipeline } from './watchPipeline.js';
import { saveRunState } from '../state/runState.js';
import { step, runStep, note, noteRisk } from '../ui/steps.js';
import { printWelcome } from '../ui/welcome.js';
import type { RunPhase, RunState } from '../types.js';

/** Function-boundary read so TS reports the declared RunPhase union, not a narrowed literal. */
function readPhase(state: RunState): RunPhase {
  return state.phase;
}

export async function runWorkflow(repoRoot: string): Promise<void> {
  const config = loadConfig(repoRoot);
  const forge = createForge(config);
  const agent = selectAgent(config);
  await printWelcome(config, repoRoot);

  const { diffText, untrackedFiles } = await runStep(
    1,
    '📸',
    'Capturing your changes',
    'reading uncommitted edits and untracked files from your repo',
    () => captureDiff(repoRoot),
  );
  if (diffText.trim().length === 0 && untrackedFiles.length === 0) {
    console.log('pipeline-worker: no changes to process.');
    return;
  }
  note(`${untrackedFiles.length} new file(s), ${diffText.split('\n').length} line(s) of diff`);

  const targetBranch = await currentBranch(repoRoot);
  const tempBranch = generateTempBranchName();
  const worktreePath = await runStep(
    2,
    '🌳',
    'Creating worktree',
    `create worktree with name ${tempBranch}`,
    () => createWorktree(repoRoot, tempBranch),
  );

  let state: RunState = { branch: tempBranch, worktreePath, attempt: 0, phase: 'diff' };
  saveRunState(repoRoot, state);

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
    await runStep(
      3,
      '📦',
      'Applying your changes',
      'replay your diff and untracked files into the new worktree',
      () => applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot),
    );

    const intent = await runStep(
      4,
      '🧠',
      'Understanding your changes',
      `ask ${config.agent} to infer a branch name, commit message, and summary`,
      () => captureIntent(agent, diffText, worktreePath),
    );
    note(`${config.agent} says: ${intent.summary}`);
    noteRisk(intent.risk, intent.riskReason);

    await runStep(
      5,
      '🌿',
      'Checkout feature branch',
      `switch to feature branch ${intent.branchName}`,
      () => renameBranch(worktreePath, intent.branchName),
    );
    state = { ...state, branch: intent.branchName, phase: 'intent' };
    saveRunState(repoRoot, state);

    const checks = await runStep(
      6,
      '✅',
      'Running checks',
      'build, lint, and test — whichever your repo has configured',
      () => runChecks(config, worktreePath),
    );
    for (const check of checks) note(`${check.name}: ${check.ok ? 'passed' : 'failed'} (${(check.durationMs / 1000).toFixed(1)}s)`);
    const failedCheck = checks.find((c) => !c.ok);
    if (failedCheck) {
      console.error(
        `pipeline-worker: ${failedCheck.name} failed, aborting before opening a merge request.\n${failedCheck.stderr}`,
      );
      process.exitCode = 1;
      return;
    }
    state.phase = 'checks';
    saveRunState(repoRoot, state);

    await runStep(
      7,
      '💾',
      'Committing changes',
      `commit message: "${intent.commitMessage}"`,
      // applyDiffToWorktree left everything staged; without this commit the
      // push would carry no changes and the MR would be empty.
      () => commit(worktreePath, intent.commitMessage),
    );

    const mr = await openMergeRequest(forge, worktreePath, state.branch, targetBranch, intent, config.agent);
    state.mrIid = mr.iid;
    state.phase = 'mr';
    saveRunState(repoRoot, state);

    await watchPipeline(forge, config, agent, worktreePath, state.branch, mr.iid, state, repoRoot);

    // watchPipeline mutates state.phase in place; go through a function
    // boundary so TS uses the declared RunPhase return type instead of the
    // 'mr' literal it narrowed state.phase to just before the call.
    const finalPhase = readPhase(state);
    if (finalPhase === 'done') {
      step('🎉', 'Done', `MR ${mr.webUrl} passed CI`);
    } else if (finalPhase === 'escalated') {
      step('🚨', 'Stopped for human review', `see ${mr.webUrl} for what was tried and why`);
      process.exitCode = 1;
    }
  } finally {
    await cleanup();
  }
}
