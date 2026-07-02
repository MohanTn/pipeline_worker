/**
 * Steps 4-5: real build/lint/test commands, script-based. Pass/fail comes
 * from process exit codes only — the agent is never asked to judge these,
 * only to fix a failure the scripts already reported (see watchPipeline.ts).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckResult, PipelineWorkerConfig } from '../types.js';

const execFileAsync = promisify(execFile);

async function runStage(name: CheckResult['name'], command: string, cwd: string): Promise<CheckResult> {
  // execFile (not exec) runs argv directly with no shell, so command must be
  // plain space-separated argv — no quoting, pipes, or `&&` chains.
  const [cmd, ...args] = command.split(' ');
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { name, ok: true, stdout, stderr, durationMs: Date.now() - start };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      name,
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? String(error),
      durationMs: Date.now() - start,
    };
  }
}

/** Runs build, then lint, then test, stopping at the first failure (fail-fast). */
export async function runChecks(config: PipelineWorkerConfig, worktreePath: string): Promise<CheckResult[]> {
  const stages: Array<{ name: CheckResult['name']; command: string }> = [
    { name: 'build', command: config.build },
    { name: 'lint', command: config.lint },
    { name: 'test', command: config.test },
  ];

  const results: CheckResult[] = [];
  for (const stage of stages) {
    if (!stage.command.trim()) continue; // empty command = no default for this toolchain, stage skipped
    const result = await runStage(stage.name, stage.command, worktreePath);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}
