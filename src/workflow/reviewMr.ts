/**
 * Optional stage, run once the MR/PR is open and before CI is watched: ask
 * the agent to review the branch's own diff and post what it finds as
 * line-anchored comments on the MR/PR, so a human opening it sees the
 * concerns next to the code instead of in a wall of description text.
 *
 * A best-effort stage under CLAUDE.md's never-throw contract: an unreachable
 * merge-base, an agent that answers with prose, a forge that rejects a
 * position — each is reduced to a note and the run's outcome is unchanged.
 * Nothing downstream (CI watch, auto-merge, cleanup) depends on it.
 *
 * (Named reviewMr.ts, not reviewMergeRequest.ts as its sibling
 * openMergeRequest.ts would suggest: a `*Request.ts` file name is reserved
 * for generated request boilerplate by a repo-external tooling guard.)
 */

import { mergeBase } from '../git/commit.js';
import { diffTextSinceRef } from '../git/diff.js';
import { chunkDiff, groupChunks } from '../review/chunkDiff.js';
import { normalizeSuggestionFence } from '../review/findings.js';
import { buildRoundContext } from '../review/prompt.js';
import { reviewDiff } from '../review/reviewDiff.js';
import { classifyFindings, findingKey } from '../review/selection.js';
import { note, runStep, skipStep } from '../ui/steps.js';
import type { AgentAdapter } from '../agent/types.js';
import type { ForgeClient } from '../forge/types.js';
import type { FindingCandidate, FindingSelector, ReviewTurnRecord, SelectableFinding } from '../review/selection.js';
import type { DiffChunk, ReviewFinding } from '../review/types.js';
import type { ForgeName, PipelineWorkerConfig } from '../types.js';

/**
 * A follow-up run (orchestrate.ts's runFollowUpMrStage) adds one commit to an
 * MR/PR that may already carry a long history of reviewed commits. Reviewing
 * the whole branch diff there would re-flag lines a human has already read
 * and possibly resolved, so the caller passes the files *this run* touched
 * and the review is narrowed to them.
 */
export function scopeChunks(chunks: DiffChunk[], scopeFiles: string[] | undefined): DiffChunk[] {
  if (!scopeFiles) return chunks;
  const wanted = new Set(scopeFiles);
  return chunks.filter((chunk) => wanted.has(chunk.path));
}

/**
 * Room the review prompt's instructions and per-file headers need on top of the
 * diff itself (see review/prompt.ts). Held back from little-coder's budget so
 * its adapter's middle-out trim never lands inside the patch, which would
 * renumber lines and make every finding unpostable.
 */
const REVIEW_PROMPT_OVERHEAD_CHARS = 1_500;

/** Files per turn for a small local model: enough neighbouring context to be useful, few enough to stay inside an 8-12k context. */
const LOCAL_FILES_PER_TURN = 3;

/** Never leave a local turn with less diff than this, however small maxPromptChars is set — below it a "review" is meaningless. */
const MIN_LOCAL_TURN_CHARS = 2_000;

/**
 * How much diff one review turn carries, for this agent. A cloud model gets the
 * whole MR/PR in one session (that is what the reviewChunkChars default is
 * sized for), and `little-coder` — pi against a small local model — gets a few
 * files at a time, clamped to its own prompt cap so the adapter never truncates
 * a diff it is being asked to anchor comments in. Explicit settings win over
 * both: only `reviewFilesPerTurn: 0` defers to the agent.
 */
export function reviewTurnLimits(config: PipelineWorkerConfig): { maxChars: number; maxFiles: number } {
  // The cloud path deliberately reads nothing from the littleCoder section:
  // one whole-diff turn is decided by reviewChunkChars alone.
  if (config.agent !== 'little-coder') return { maxChars: config.reviewChunkChars, maxFiles: config.reviewFilesPerTurn };

  const promptCap = config.littleCoder.maxPromptChars;
  const localCap = promptCap > 0 ? Math.max(MIN_LOCAL_TURN_CHARS, promptCap - REVIEW_PROMPT_OVERHEAD_CHARS) : Number.POSITIVE_INFINITY;
  return {
    maxChars: Math.min(config.reviewChunkChars, localCap),
    maxFiles: config.reviewFilesPerTurn > 0 ? config.reviewFilesPerTurn : LOCAL_FILES_PER_TURN,
  };
}

/**
 * What a review-shaped stage leaves behind: how many comments landed, and
 * whether the stage is willing to vouch for the diff.
 *
 * `clean` is affirmative evidence, never the absence of errors — under the
 * never-throw contract every failure path here returns 0 comments, and "we
 * could not look" must never read the same as "we looked and it was fine".
 * Only workflow/approveMr.ts consumes it.
 */
export interface ReviewOutcome {
  posted: number;
  clean: boolean;
  /** Set only for a round-aware review (see ReviewRound) — what the caller persists as this round's history. */
  round?: ReviewRoundResult;
}

/** What one review round did, in the finding keys state/reviewTurns.ts records. */
export interface ReviewRoundResult {
  turn: number;
  posted: string[];
  ignored: string[];
  edited: string[];
}

/**
 * A later review of the same MR/PR. Carries what earlier rounds did (so a
 * comment is not posted twice) and, when the terminal is interactive, the
 * human's pick of what should actually go out.
 */
export interface ReviewRound {
  turn: number;
  priorTurns: ReviewTurnRecord[];
  /** Threads opened since the previous round, rendered into the prompt so the agent answers them instead of re-deriving the diff cold. */
  newThreads: string[];
  /**
   * Offers the round's findings to the human. Returns what to post — bodies
   * possibly rewritten — or `undefined` when the human cancelled, which posts
   * nothing and records nothing, so the next round offers the same findings
   * unchanged. Absent entirely (non-TTY, CI) means "post every new finding".
   */
  selectFindings?: FindingSelector;
}

/** The comment body as it reaches the forge: the human's text when the picker's editor was used, otherwise the agent's, credited accordingly. */
export function renderFindingBody(finding: SelectableFinding, forgeName: ForgeName, agentName: string): string {
  const text = normalizeSuggestionFence(finding.body ?? finding.comment, forgeName);
  const credit = finding.edited ? `${agentName}, edited` : agentName;
  return `${text}\n\n_${finding.severity} · pipeline-worker review (${credit})_`;
}

/** Posts each surviving finding, individually: one rejected position must not cost the comments that would still land. Returns the ones that landed. */
export async function postFindings(
  forge: ForgeClient,
  mrIid: number,
  findings: SelectableFinding[],
  forgeName: ForgeName,
  agentName: string,
): Promise<SelectableFinding[]> {
  const posted: SelectableFinding[] = [];
  for (const finding of findings) {
    try {
      await forge.createInlineComment(mrIid, { path: finding.file, line: finding.line, body: renderFindingBody(finding, forgeName, agentName) });
      posted.push(finding);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      note(`could not comment on ${finding.file}:${finding.line} — ${message}`);
    }
  }
  return posted;
}

/** A round that reviewed and found nothing: still recorded, so the next round is numbered from it and diffs against its thread baseline. */
function emptyRound(turn: number): ReviewRoundResult {
  return { turn, posted: [], ignored: [], edited: [] };
}

/**
 * Where earlier rounds already left comments, as `file:line` — the anchor half
 * of a finding key (see selection.ts). Only the location is kept, not the
 * comment text: it is enough for "do not repeat these" and costs the prompt
 * one short line per comment rather than a whole markdown body.
 */
function postedSummaries(round: ReviewRound): string[] {
  const anchors = round.priorTurns.flatMap((record) => record.posted).map((key) => key.slice(0, key.lastIndexOf(':')));
  return [...new Set(anchors)];
}

/**
 * Drops what an earlier round already posted and hands the rest to the human
 * when there is one. Returns undefined when the human cancelled — distinct
 * from an empty selection, which is "I read them and want none of these" and
 * is remembered as ignored.
 */
async function chooseFindings(findings: ReviewFinding[], round: ReviewRound): Promise<{ chosen: SelectableFinding[]; offered: FindingCandidate[] } | undefined> {
  const candidates = classifyFindings(findings, round.priorTurns);
  const offered = candidates.filter((candidate) => candidate.status !== 'seen');
  const seen = candidates.length - offered.length;
  if (seen > 0) note(`${seen} finding(s) already posted in an earlier round — not repeating them`);
  if (!round.selectFindings) return { chosen: offered.filter((candidate) => candidate.status === 'new').map((candidate) => candidate.finding), offered };
  // The picker gets the suppressed ones too — it hides them behind `d` rather
  // than pretending they were never found.
  const chosen = await round.selectFindings(candidates, round.turn);
  return chosen === undefined ? undefined : { chosen, offered };
}

/** Reviews the diff and posts what it finds. `posted` is 0 when disabled, when nothing survived the gate, or when anything failed. Never rejects. */
export async function maybeReviewMergeRequest(
  forge: ForgeClient,
  config: PipelineWorkerConfig,
  agent: AgentAdapter,
  worktreePath: string,
  targetBranch: string,
  mrIid: number,
  scopeFiles?: string[],
  round?: ReviewRound,
): Promise<ReviewOutcome> {
  if (!config.review) {
    skipStep('review', 'config.review is disabled — set PIPELINE_WORKER_REVIEW=true to have the agent review its own diff');
    return { posted: 0, clean: false };
  }

  try {
    return await runStep('review', `${config.agent} reviews the diff and comments on the lines it flags`, async () => {
      const limits = reviewTurnLimits(config);
      const base = await mergeBase(worktreePath, `origin/${targetBranch}`);
      const chunks = scopeChunks(chunkDiff(await diffTextSinceRef(worktreePath, base), limits.maxChars), scopeFiles);
      if (chunks.length === 0) {
        // Not clean: an empty review is not a passed review, and there is
        // nothing here for anyone to approve either.
        note('nothing reviewable in this diff (no added lines a comment could anchor to)');
        return { posted: 0, clean: false };
      }

      const turns = groupChunks(chunks, limits.maxChars, limits.maxFiles);
      const fileCount = new Set(chunks.map((chunk) => chunk.path)).size;
      note(`reviewing ${fileCount} file(s) in ${turns.length} agent turn(s)${round && round.turn > 1 ? ` — round ${round.turn}` : ''}`);
      const { findings } = await reviewDiff(agent, turns, worktreePath, {
        model: config.reviewModel,
        minSeverity: config.reviewMinSeverity,
        maxComments: config.reviewMaxComments,
        forge: config.forge,
        ...(round ? { roundContext: buildRoundContext(round.turn, postedSummaries(round), round.newThreads) } : {}),
      });
      if (findings.length === 0) {
        note(`no findings at or above ${config.reviewMinSeverity} — nothing worth commenting on`);
        return { posted: 0, clean: true, ...(round ? { round: emptyRound(round.turn) } : {}) };
      }
      if (!round) {
        const posted = await postFindings(forge, mrIid, findings, config.forge, config.agent);
        note(`posted ${posted.length} of ${findings.length} review comment(s)`);
        return { posted: posted.length, clean: false };
      }

      const selection = await chooseFindings(findings, round);
      if (!selection) {
        note('review cancelled — nothing posted, and nothing remembered as ignored');
        return { posted: 0, clean: false };
      }
      const posted = await postFindings(forge, mrIid, selection.chosen, config.forge, config.agent);
      const postedKeys = new Set(posted.map((finding) => findingKey(finding)));
      note(`posted ${posted.length} of ${selection.offered.length} review comment(s) in round ${round.turn}`);
      return {
        posted: posted.length,
        clean: false,
        round: {
          turn: round.turn,
          posted: [...postedKeys],
          ignored: selection.offered.map((candidate) => candidate.key).filter((key) => !postedKeys.has(key)),
          edited: posted.filter((finding) => finding.edited).map((finding) => findingKey(finding)),
        },
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`review skipped: ${message}`);
    return { posted: 0, clean: false };
  }
}
