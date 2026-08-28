/**
 * promptfoo custom provider for the intent-capture eval.
 *
 * There is no prompt template to fill in: captureIntent() builds the real
 * prompt itself from a live git diff, so promptfoo's "prompt" is just the
 * scenario name (see promptfooconfig.yaml's `prompts`/`vars.scenario`) and
 * this provider does the actual work — build a temp git worktree matching
 * the scenario, run the real captureIntent() against the real `claude` CLI
 * adapter (the exact code path production uses), and hand the validated
 * intent JSON back for promptfoo's assertions to check.
 *
 * Requires `npm run build` to have run first (imports from dist/, not src/,
 * so this file stays plain ESM with no ts-node/tsx dependency of its own)
 * and the `claude` CLI to be installed and authenticated — the same
 * requirement pipeline-worker itself has.
 */

import { captureIntent } from '../dist/workflow/captureIntent.js';
import { claudeAdapter } from '../dist/agent/claude.js';
import { buildWorktree } from './fixtures.mjs';

// Matches config/loader.ts's intentModel default, so the eval exercises the
// same model production uses for this turn.
const INTENT_MODEL = 'haiku';

// promptfoo instantiates a custom `file://` JS provider with `new`, so this
// must be a class, not a plain object literal.
export default class CaptureIntentProvider {
  id() {
    return 'pipeline-worker:intent-capture';
  }

  async callApi(_prompt, context) {
    const scenario = context?.vars?.scenario;
    if (!scenario) return { error: 'test case is missing a "scenario" var' };

    const worktree = await buildWorktree(scenario);
    try {
      const { intent } = await captureIntent(claudeAdapter, worktree.files, worktree.dir, INTENT_MODEL);
      return { output: JSON.stringify(intent, null, 2) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      worktree.cleanup();
    }
  }
}
