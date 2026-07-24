/**
 * One agent turn per chunk, sequentially: a large MR/PR is reviewed piece by
 * piece so no single turn ever exceeds the model's context, and a chunk whose
 * answer is unusable costs only that chunk (parseFindings returns [] and the
 * loop continues) instead of the whole review.
 *
 * The turn is read-only by construction — the same tool allowlist stance as
 * captureIntent.ts. A reviewer that could edit the worktree would be able to
 * "fix" the very diff the run is about to push.
 */

import { gatekeep, parseFindings } from './findings.js';
import { REVIEW_SCHEMA, buildReviewPrompt, suggestionFence } from './prompt.js';
import type { DiffChunk, ReviewFinding, ReviewSeverity } from './types.js';
import type { AgentAdapter, AgentUsage } from '../agent/types.js';
import type { ForgeName } from '../types.js';
import { noteSession } from '../ui/steps.js';

/** Read-only tools: enough to open a neighbouring file when the chunk alone doesn't settle a question, nothing that can mutate the worktree. */
const REVIEW_TOOLS = ['Read', 'Grep', 'Glob'];

export interface ReviewOptions {
  /** Empty string means "the adapter's default model" — reviewing for real bugs is deliberately not the cheap-model job intent capture is. */
  model: string;
  minSeverity: ReviewSeverity;
  maxComments: number;
  forge: ForgeName;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  /** Summed across every chunk's turn, when the adapter reports usage at all. */
  usage?: AgentUsage;
}

function addUsage(total: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined {
  if (!next) return total;
  if (!total) return { ...next };
  const sum = (a?: number, b?: number) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(total.inputTokens, next.inputTokens),
    outputTokens: sum(total.outputTokens, next.outputTokens),
    totalTokens: sum(total.totalTokens, next.totalTokens),
    costUsd: sum(total.costUsd, next.costUsd),
    numTurns: sum(total.numTurns, next.numTurns),
  };
}

export async function reviewDiff(agent: AgentAdapter, chunks: DiffChunk[], worktreePath: string, opts: ReviewOptions): Promise<ReviewResult> {
  const fence = suggestionFence(opts.forge);
  const collected: ReviewFinding[] = [];
  let usage: AgentUsage | undefined;

  for (const chunk of chunks) {
    const result = await agent.invoke({
      prompt: buildReviewPrompt(chunk, fence),
      cwd: worktreePath,
      jsonSchema: REVIEW_SCHEMA,
      permissionMode: 'default',
      allowedTools: REVIEW_TOOLS,
      ...(opts.model ? { model: opts.model } : {}),
    });
    noteSession(result, worktreePath);
    usage = addUsage(usage, result.usage);
    collected.push(...parseFindings(result.text));
  }

  return { findings: gatekeep(collected, chunks, opts.minSeverity, opts.maxComments), usage };
}
