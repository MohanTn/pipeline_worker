/**
 * Steps 4-5: real build/lint/test commands, script-based. Pass/fail comes
 * from process exit codes only — the agent is never asked to judge these,
 * only to fix a failure the scripts already reported (see watchPipeline.ts).
 */

import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckResult, PipelineWorkerConfig } from '../types.js';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Shell operators (&&, ||, ;, |, backticks, redirects) require a shell
 * interpreter. Commands that contain any of these are routed to exec();
 * plain commands (no shell metacharacters) use execFile() for tighter control.
 */
const NEEDS_SHELL = /&&|\|\|?|[;`<>()]|\$\(/;

/**
 * Splits a command into argv, keeping "..."/'...'-quoted substrings (e.g. a
 * dotnet test filter) together as one argument instead of splitting on the
 * spaces inside them.
 */
export function parseCommand(command: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

async function runStage(name: CheckResult['name'], command: string, cwd: string): Promise<CheckResult> {
  const start = Date.now();
  const opts = { cwd, maxBuffer: 64 * 1024 * 1024 };
  try {
    let stdout: string;
    let stderr: string;
    if (NEEDS_SHELL.test(command)) {
      // Shell-compound commands (e.g. 'dotnet tool restore && dotnet csharpier check .')
      ({ stdout, stderr } = await execAsync(command, opts));
    } else {
      const [cmd, ...args] = parseCommand(command);
      ({ stdout, stderr } = await execFileAsync(cmd, args, opts));
    }
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

/**
 * Runs build, then lint, then test, stopping at the first failure (fail-fast).
 * lint/test are skipped when config.runLintAndTest is false — e.g. when an
 * earlier workflow such as upstream CI already verified them.
 */
export async function runChecks(config: PipelineWorkerConfig, worktreePath: string): Promise<CheckResult[]> {
  const stages: Array<{ name: CheckResult['name']; command: string }> = [
    { name: 'build', command: config.build },
    { name: 'lint', command: config.runLintAndTest ? config.lint : '' },
    { name: 'test', command: config.runLintAndTest ? config.test : '' },
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
