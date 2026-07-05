/**
 * Idempotent-cleanup + SIGINT/SIGTERM wiring shared by `run` (orchestrate.ts)
 * and `resume` (cli.ts): both remove the worktree at most once on interrupt,
 * then exit with the signal's conventional code. `markDone` lets a caller
 * (e.g. orchestrate.ts's "preserve worktree for resume" branch) mark cleanup
 * as already satisfied without running `fn` — kept separate from `cleanup`
 * itself since callers may need to skip the side effect for reasons the
 * shared flag-guard alone can't express.
 */
export interface IdempotentCleanup {
  cleanup: () => Promise<void>;
  markDone: () => void;
}

export function makeIdempotentCleanup(fn: () => Promise<void> | void): IdempotentCleanup {
  let cleanedUp = false;
  return {
    cleanup: async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await fn();
    },
    markDone: () => {
      cleanedUp = true;
    },
  };
}

export function registerExitSignals(onSignal: (exitCode: number) => void): void {
  process.once('SIGINT', () => onSignal(130));
  process.once('SIGTERM', () => onSignal(143));
}
