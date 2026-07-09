/**
 * Declares the step skeletons each entry point renders as its run tree —
 * kept out of orchestrate.ts so the control flow stays control flow and the
 * tree shape is one readable literal per entry point.
 *
 * Ids are the contract between skeletons and the workflow code that starts/
 * finishes steps (ui/steps.ts facade). Shared helpers (runAndReportChecks,
 * maybeUpdateChangelog, openMergeRequest, watchPipeline, maybeSyncTargetBranch)
 * reference the ids 'checks', 'changelog', 'push', 'mr', 'ci-watch', and
 * 'merge' — any skeleton whose flow reaches those helpers must declare them.
 */

import type { StepSeed } from '../ui/runTree.js';

/** A fresh `pipeline-worker run`: the full capture-to-merge sequence. */
export function freshRunSkeleton(targetBranch: string, agentName: string): StepSeed[] {
  return [
    { id: 'capture', label: 'capture', detail: 'staged + unstaged diff' },
    { id: 'worktree', label: 'worktree', detail: 'disposable copy on a temp branch' },
    { id: 'sync', label: 'sync', detail: `pull --rebase origin ${targetBranch}` },
    { id: 'apply', label: 'apply', detail: 'replay diff into the worktree' },
    { id: 'intent', label: 'intent', detail: `${agentName} infers type · slug · commit message` },
    { id: 'branch', label: 'branch', detail: 'checkout feature branch' },
    { id: 'checks', label: 'checks', detail: 'build · lint · test' },
    { id: 'changelog', label: 'changelog', detail: 'CHANGELOG.md bullet' },
    { id: 'commit', label: 'commit', detail: 'commit the applied changes' },
    { id: 'push', label: 'push', detail: 'push the feature branch to origin' },
    { id: 'mr', label: 'mr', detail: 'open the merge request' },
    { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI · fix failures · resolve conflicts' },
    { id: 'cleanup', label: 'cleanup', detail: 'reset your repo to HEAD' },
    { id: 'merge', label: 'merge', detail: `auto-merge + sync local ${targetBranch}` },
  ];
}

/** `pipeline-worker resume` on a run with persisted state: only the watch tail actually executes — faking the earlier steps as done would lie. */
export function resumeSkeleton(targetBranch: string): StepSeed[] {
  return [
    { id: 'resume', label: 'resume', detail: 'reattach to the persisted run' },
    { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI · fix failures · resolve conflicts' },
    { id: 'merge', label: 'merge', detail: `auto-merge + sync local ${targetBranch}` },
  ];
}

/** `pipeline-worker resume` adopting a branch with no persisted state: inspect it, open/refresh its MR/PR, then the watch tail. */
export function adoptSkeleton(branch: string): StepSeed[] {
  return [
    { id: 'adopt', label: 'adopt', detail: `fetch + checkout origin/${branch}` },
    { id: 'inspect', label: 'inspect', detail: 'diff the branch against its target' },
    { id: 'checks', label: 'checks', detail: 'build · lint · test' },
    { id: 'intent', label: 'intent', detail: 'infer summary · risk · file breakdown' },
    { id: 'changelog', label: 'changelog', detail: 'CHANGELOG.md bullet' },
    { id: 'push', label: 'push', detail: 'push the branch to origin' },
    { id: 'mr', label: 'mr', detail: 'open or refresh the merge request' },
    { id: 'ci-watch', label: 'ci-watch', detail: 'watch CI · fix failures · resolve conflicts' },
    { id: 'merge', label: 'merge', detail: 'auto-merge + sync local target' },
  ];
}
