/**
 * Rewriting one review comment with a human in the loop: the picker's detail
 * view (ui/tui/views/reviewPicker.ts) offers "reconsider this with an agent,
 * plus whatever extra context I type", and this module turns that into an
 * actual interactive CLI session.
 *
 * Unlike src/agent/* (headless `-p`/JSON turns, piped stdin, no TTY), this
 * hands the *real* terminal to `claude` / `copilot` / `pi` running
 * interactively — full tool access, the CLI's own UI, the human typing back
 * and forth with it — because "consider another point of view" is a
 * conversation, not a one-shot prompt. The child is told, as part of its
 * opening prompt, to save its final answer to a temp file; once it exits we
 * read that file back. There is no way to force it to comply — this is a
 * best-effort handoff, not a contract enforced by any flag.
 *
 * CLI shapes verified against the installed binaries (`<cli> --help`):
 * `claude [prompt]` and `pi [messages...]` start interactive with that
 * opening message when `-p`/`--print` is omitted; `copilot -i <prompt>`
 * ("Start interactive mode and automatically execute this prompt") is
 * copilot's equivalent.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ReviewFinding } from './types.js';

export type RewriteAgent = 'claude' | 'copilot' | 'pi';

/** The three interactive CLIs this feature can hand a comment to — deliberately not little-coder, which has no interactive mode of its own. */
export const REWRITE_AGENTS: readonly RewriteAgent[] = ['claude', 'copilot', 'pi'];

/** What the picker's detail view has in hand when it asks an agent to reconsider one comment. */
export interface RewriteAsk {
  finding: ReviewFinding;
  /** The comment as it currently reads in the picker (the agent's original text, or an earlier hand-edit). */
  currentBody: string;
  /** Free text the reviewer typed, e.g. "consider the perf angle too" — empty means just "reconsider this". */
  context: string;
  agent: RewriteAgent;
}

/** Runs one CLI with the real terminal handed to it, resolving once it exits (any exit code — a non-zero exit here just means no rewrite came back). */
export interface ProcessRunner {
  run(command: string, args: string[], cwd: string): Promise<void>;
}

export const nodeProcessRunner: ProcessRunner = {
  run(command, args, cwd) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', () => resolve());
    });
  },
};

/**
 * The opening message handed to the interactive CLI: what the comment
 * currently says, whatever extra context the reviewer typed, and where to
 * save the final answer. Pure and exported for unit testing — the actual
 * spawn is the untestable part.
 */
export function buildRewritePrompt(ask: RewriteAsk, outFile: string): string {
  const { finding, currentBody, context } = ask;
  const lines: (string | undefined)[] = [
    "You are helping a reviewer reconsider one code review comment from pipeline-worker's automated review pass.",
    '',
    `Location: ${finding.file}:${finding.line} (${finding.severity})`,
    finding.code ? `Flagged line:\n${finding.code}` : undefined,
    '',
    'Current comment:',
    '---',
    currentBody,
    '---',
  ];
  if (context.trim() !== '') {
    lines.push('', 'Additional context from the reviewer to take into account:', context.trim());
  }
  lines.push(
    '',
    'Talk it through with the reviewer if that helps. Once you both settle on the final wording, write ONLY the ' +
      'finished markdown comment body (no preamble, no surrounding code fence) to this exact file path, overwriting ' +
      `anything already there: ${outFile}`,
    'The review picker reads that file back as the new comment body once this session ends.',
  );
  return lines.filter((line): line is string => line !== undefined).join('\n');
}

/** The CLI's own way of starting interactive with an opening message — see the file comment for what was verified. */
export function agentCliArgs(agent: RewriteAgent, prompt: string): string[] {
  switch (agent) {
    case 'claude':
      return [prompt];
    case 'copilot':
      return ['-i', prompt];
    case 'pi':
      return [prompt];
  }
}

/**
 * Hands the terminal to `ask.agent`, seeded with the comment plus the
 * reviewer's extra context, and waits for it to exit. Returns the rewritten
 * body the agent saved to its temp file, or undefined when it saved nothing
 * (crashed, was quit early, or simply didn't get around to it) — the caller
 * treats that as "leave the comment as it was".
 */
export async function runAgentRewrite(ask: RewriteAsk, cwd: string, runner: ProcessRunner = nodeProcessRunner): Promise<string | undefined> {
  const outFile = join(tmpdir(), `pipeline-worker-rewrite-${randomUUID()}.md`);
  const prompt = buildRewritePrompt(ask, outFile);
  try {
    await runner.run(ask.agent, agentCliArgs(ask.agent, prompt), cwd);
    if (!existsSync(outFile)) return undefined;
    const text = readFileSync(outFile, 'utf8').trim();
    return text === '' ? undefined : text;
  } finally {
    try {
      unlinkSync(outFile);
    } catch {
      // Best-effort cleanup: the agent may never have created it.
    }
  }
}
