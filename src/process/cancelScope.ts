/**
 * Cooperative cancellation for one in-flight run.
 *
 * The workflow is a long chain of awaited stages with no context object to
 * thread an AbortSignal through, so the token is a module-level scope —
 * deliberately mirroring how ui/steps.ts already holds the active renderer as
 * a singleton (setRenderer). The TUI arms a scope for the duration of a job
 * (ui/tui/views/runDashboard.ts's runInDashboard) and disposes it in the same
 * `.finally` that clears the renderer.
 *
 * Cancellation surfaces as a thrown RunCancelledError at the next step
 * boundary (ui/steps.ts's runStep/runPhase) or immediately out of a poll
 * sleep, so it unwinds every awaited stage and lands in the try/catch that
 * runWorkflow already has. Nothing else in the workflow knows cancellation
 * exists.
 *
 * With no scope armed — every plain CLI invocation — throwIfCancelled() is a
 * no-op and cancellableSleep() is a plain setTimeout, so non-TUI runs behave
 * exactly as they did before. The CLI keeps using real SIGINT through
 * process/signalCleanup.ts; this is the TUI's equivalent, minus the
 * process.exit it cannot afford.
 */

/** Thrown at the first boundary after requestCancel(). Caught by name in orchestrate.ts, never surfaced to the user as a failure. */
export class RunCancelledError extends Error {
  constructor(message = 'Run cancelled') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

interface CancelScope {
  cancelled: boolean;
  /** Pending cancellableSleep waiters, woken early when the run is cancelled. */
  sleepers: Set<() => void>;
}

let active: CancelScope | undefined;

/**
 * Arms a scope for one run and returns its disposer. The disposer only clears
 * the scope if it is still the active one, so a stale disposer from an earlier
 * run can never disarm the current one.
 */
export function beginCancelScope(): () => void {
  const scope: CancelScope = { cancelled: false, sleepers: new Set() };
  active = scope;
  return () => {
    if (active === scope) active = undefined;
    scope.sleepers.clear();
  };
}

/** Asks the active run to stop at its next boundary. No-op when no run is armed, or when one is already stopping. */
export function requestCancel(): void {
  const scope = active;
  if (!scope || scope.cancelled) return;
  scope.cancelled = true;
  for (const wake of [...scope.sleepers]) wake();
}

export function isCancelRequested(): boolean {
  return active?.cancelled === true;
}

/** Boundary check. A no-op with no scope armed, so plain CLI runs pay nothing for this. */
export function throwIfCancelled(): void {
  if (active?.cancelled) throw new RunCancelledError();
}

/**
 * setTimeout that rejects the moment the run is cancelled, so a poll loop
 * waiting out a 15s CI interval stops in milliseconds instead of finishing
 * the wait first.
 */
export function cancellableSleep(ms: number): Promise<void> {
  const scope = active;
  if (!scope) return new Promise((resolve) => setTimeout(resolve, ms));
  if (scope.cancelled) return Promise.reject(new RunCancelledError());
  return new Promise((resolve, reject) => {
    // `timer` is only ever read from inside wake(), which cannot run before
    // the sleeper is registered two lines below — no TDZ hazard.
    const wake = (): void => {
      clearTimeout(timer);
      scope.sleepers.delete(wake);
      reject(new RunCancelledError());
    };
    const timer = setTimeout(() => {
      scope.sleepers.delete(wake);
      resolve();
    }, ms);
    scope.sleepers.add(wake);
  });
}
