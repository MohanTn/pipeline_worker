/** Top-level control flow wiring the user's 8-step workflow together. */

import { loadConfig } from '../config/loader.js';
import { createForge } from '../forge/index.js';
import { selectAgent } from '../agent/index.js';
import { captureDiff, resetRepo } from '../git/diff.js';
import { buildBranchName } from '../git/branchName.js';
import { createWorktree, syncWithOrigin, applyDiffToWorktree, removeWorktree, renameBranch, generateTempBranchName } from '../git/worktree.js';
import { currentBranch, commit, stageAll, findUnresolvedConflictMarkers } from '../git/commit.js';
import { captureIntent } from './captureIntent.js';
import { runChecks } from './runChecks.js';
import { updateChangelog } from './updateChangelog.js';
import { openMergeRequest } from './openMergeRequest.js';
import { watchPipeline } from './watchPipeline.js';
import { recordEvent } from '../state/runState.js';
import { acquireLock } from '../state/lock.js';
import { step, runStep, note, noteRisk, noteSession } from '../ui/steps.js';
import { printWelcome } from '../ui/welcome.js';
import type { AgentAdapter } from '../agent/types.js';
import type { RunPhase, RunState } from '../types.js';

/** Function-boundary read so TS reports the declared RunPhase union, not a narrowed literal. */
function readPhase(state: RunState): RunPhase {
  return state.phase;
}

/** Phases from 'mr' onward have an open MR/PR that `resume` continues pushing fixes to. */
const RESUMABLE_PHASES: RunPhase[] = ['mr', 'watch'];

/**
 * True once the run has an open MR/PR — from that point, `pipeline-worker
 * resume` needs the worktree to still exist to keep pushing CI-fix/conflict
 * resolution commits, so an interrupt must leave it in place instead of
 * deleting it. Before that point (still capturing/applying/checking the
 * diff), there is no MR to resume against, so the worktree is safe — and
 * meant — to remove on interrupt. Exported for unit testing.
 */
export function shouldPreserveWorktreeOnInterrupt(phase: RunPhase): boolean {
  return RESUMABLE_PHASES.includes(phase);
}

function buildApplyConflictPrompt(conflictedFiles: string[]): string {
  return (
    `Applying your diff produced merge conflicts (the target branch moved since the diff was captured) in: ${conflictedFiles.join(', ')}. ` +
    'Resolve the conflict markers (<<<<<<<, =======, >>>>>>>) in each file by choosing the correct combined content ' +
    'that preserves the intent of both sides, then remove the markers.'
  );
}

/**
 * A best-effort, single attempt: there's no MR yet at this point in the
 * workflow, so unlike watchPipeline.ts's CI-fix/merge-conflict loops there's
 * nothing to leave an escalation comment on if the agent can't resolve it —
 * fail the run clearly instead so the user can intervene manually.
 */
async function resolveApplyConflicts(agent: AgentAdapter, worktreePath: string, conflictedFiles: string[]): Promise<void> {
  const agentResult = await runStep(
    4,
    '🔧',
    'Resolving conflicts',
    `asking the agent to resolve ${conflictedFiles.length} conflicted file(s)`,
    () => agent.invoke({ prompt: buildApplyConflictPrompt(conflictedFiles), cwd: worktreePath, permissionMode: 'acceptEdits' }),
  );
  const agentResponse = agentResult.text;
  note(`agent: ${agentResponse.slice(0, 300).trim()}${agentResponse.length > 300 ? '…' : ''}`);
  noteSession(agentResult);

  const stillConflicted = findUnresolvedConflictMarkers(worktreePath, conflictedFiles);
  if (stillConflicted.length > 0) {
    throw new Error(
      `pipeline-worker: could not automatically resolve conflicts applying your diff — ${stillConflicted.join(', ')} ` +
        'still have conflict markers. Resolve them manually and retry.',
    );
  }
  await stageAll(worktreePath);
}

export interface RunWorkflowOptions {
  /** Ticket/issue id to interpolate into config.branchPattern's {ticket} placeholder, if it has one. */
  ticket?: string;
}

export async function runWorkflow(repoRoot: string, options: RunWorkflowOptions = {}): Promise<void> {
  const config = loadConfig(repoRoot);
  if (config.forge === 'gitlab' && !options.ticket) {
    throw new Error('forge is gitlab, which requires a ticket id — pass one with --ticket <id>.');
  }
  // Held for the whole run so a second `pipeline-worker run` in this repo
  // fails fast instead of racing this one's captureDiff/resetRepo against
  // the same working tree.
  const releaseLock = acquireLock(repoRoot);
  try {
    const forge = createForge(config);
    const agent = selectAgent(config);
    await printWelcome(config, repoRoot);

    const { diffText, changedFiles, untrackedFiles } = await runStep(
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

    let state: RunState = { branch: tempBranch, targetBranch, worktreePath, attempt: 0, phase: 'diff' };
    recordEvent(repoRoot, state, `Created worktree at ${worktreePath} (temp branch ${tempBranch})`);

    let cleanedUp = false;
    const cleanup = async (): Promise<void> => {
      if (cleanedUp) return;
      cleanedUp = true;
      await removeWorktree(repoRoot, worktreePath);
    };
    const onSignal = (exitCode: number) => {
      // process.exit() below terminates immediately without unwinding the
      // suspended runWorkflow() call stack, so the outer `finally { releaseLock() }`
      // never runs — release it explicitly here first in both branches.
      if (shouldPreserveWorktreeOnInterrupt(state.phase)) {
        // MR is already open — leave the worktree so `pipeline-worker resume`
        // can keep pushing CI-fix/conflict-resolution commits to it instead
        // of finding a dead path.
        cleanedUp = true;
        releaseLock();
        process.exit(exitCode);
        return;
      }
      void cleanup().then(() => {
        releaseLock();
        process.exit(exitCode);
      });
    };
    process.once('SIGINT', () => onSignal(130));
    process.once('SIGTERM', () => onSignal(143));

    try {
      await runStep(
        3,
        '🔄',
        'Syncing worktree with origin',
        `pull --rebase origin ${targetBranch}, so the diff lands on the latest base`,
        () => syncWithOrigin(worktreePath, targetBranch),
      );

      const applyResult = await runStep(
        4,
        '📦',
        'Applying your changes',
        'replay your diff and untracked files into the new worktree',
        () => applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot),
      );
      if (applyResult.conflicted) {
        note(`conflict in: ${applyResult.conflictedFiles.join(', ')}`);
        await resolveApplyConflicts(agent, worktreePath, applyResult.conflictedFiles);
      }

      const intent = await runStep(
        5,
        '🧠',
        'Understanding your changes',
        `ask ${config.agent} to infer a change type, branch slug, commit message, and summary`,
        () => captureIntent(agent, [...changedFiles, ...untrackedFiles], worktreePath, config.intentModel),
      );
      note(`${config.agent} says: ${intent.summary}`);
      noteRisk(intent.risk, intent.riskReason);

      const branchName = buildBranchName(config.branchPattern, { type: intent.changeType, ticket: options.ticket, name: intent.branchSlug });
      const actualBranchName = await runStep(
        6,
        '🌿',
        'Checkout feature branch',
        `switch to feature branch ${branchName}`,
        () => renameBranch(worktreePath, branchName),
      );
      if (actualBranchName !== branchName) {
        note(`"${branchName}" already exists locally — using "${actualBranchName}" instead`);
      }
      state = { ...state, branch: actualBranchName, phase: 'intent' };
      recordEvent(repoRoot, state, `Captured intent; renamed to feature branch ${actualBranchName}`);

      const checks = await runStep(
        7,
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
        recordEvent(repoRoot, state, `${failedCheck.name} check failed, aborted before opening a merge request`, 'error');
        process.exitCode = 1;
        return;
      }
      state.phase = 'checks';
      recordEvent(repoRoot, state, `Checks passed (${checks.map((c) => c.name).join(', ')})`);

      if (config.updateChangelog) {
        await runStep(
          8,
          '📝',
          'Updating changelog',
          "add a bullet under CHANGELOG.md's [Unreleased] section",
          async () => {
            updateChangelog(worktreePath, intent);
            await stageAll(worktreePath);
          },
        );
      }

      await runStep(
        9,
        '💾',
        'Committing changes',
        `commit message: "${intent.commitMessage}"`,
        // applyDiffToWorktree (and, if enabled, the changelog step above) left
        // everything staged; without this commit the push would carry no
        // changes and the MR would be empty.
        () => commit(worktreePath, intent.commitMessage),
      );

      const mr = await openMergeRequest(forge, worktreePath, state.branch, targetBranch, intent, config.agent, checks);
      state.mrIid = mr.iid;
      state.phase = 'mr';
      recordEvent(repoRoot, state, `Opened MR/PR ${mr.webUrl}`);

      if (config.cleanupOnSuccess && config.cleanupEarly) {
        // The diff is now durably committed and pushed to state.branch with an
        // MR/PR open — repoRoot's copy is redundant even though CI hasn't run
        // yet, so free it (and the run lock) for a new `pipeline-worker run`
        // immediately, rather than making the caller wait out this run's
        // CI-watch/fix loop below. releaseLock is safe to call again from the
        // outer `finally` once this run itself finishes.
        await runStep(
          12,
          '🧹',
          'Cleaning up your repo',
          `reset to HEAD — your changes are now safely pushed to ${state.branch} (MR open)`,
          () => resetRepo(repoRoot, untrackedFiles),
        );
        releaseLock();
      }

      await watchPipeline(forge, config, agent, worktreePath, state.branch, targetBranch, mr.iid, state, repoRoot);

      // watchPipeline mutates state.phase in place; go through a function
      // boundary so TS uses the declared RunPhase return type instead of the
      // 'mr' literal it narrowed state.phase to just before the call.
      const finalPhase = readPhase(state);
      if (finalPhase === 'done') {
        const detail = state.pipelineId !== undefined ? `MR ${mr.webUrl} passed CI` : `MR ${mr.webUrl} opened — no CI pipeline found, nothing to watch`;
        step('🎉', 'Done', detail);
        if (config.cleanupOnSuccess && !config.cleanupEarly) {
          // The captured changes now live safely on state.branch (pushed and,
          // per finalPhase === 'done', either merged-clean or CI-verified) —
          // repoRoot's copy is redundant, so reset it back to HEAD regardless
          // of what branch it's currently on. Skipped when cleanupEarly
          // already did this right after the MR was opened, above.
          await runStep(
            12,
            '🧹',
            'Cleaning up your repo',
            `reset to HEAD — your changes are now safely on ${state.branch}`,
            () => resetRepo(repoRoot, untrackedFiles),
          );
        }
      } else if (finalPhase === 'escalated') {
        step('🚨', 'Stopped for human review', `see ${mr.webUrl} for what was tried and why`);
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordEvent(repoRoot, state, `Run failed: ${message}`, 'error');
      throw error;
    } finally {
      await cleanup();
    }
  } finally {
    releaseLock();
  }
}
