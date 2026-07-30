/** Shared shapes for the AI review pipeline: chunked diff in, line-anchored findings out. */

export type ReviewSeverity = 'CRITICAL' | 'MAJOR' | 'MINOR';

/** Ordering used by the severity gate and by the "most severe first" sort. */
export const SEVERITY_RANK: Record<ReviewSeverity, number> = { CRITICAL: 3, MAJOR: 2, MINOR: 1 };

export interface DiffChunk {
  /** Path on the diff's *new* side — what the forge APIs anchor a comment to. */
  path: string;
  /** Human-readable language name, bundled into the prompt as context. */
  language: string;
  /** Rendered patch text: every line prefixed with its new-file line number (or `-` for removed lines). */
  body: string;
  /**
   * New-file line numbers a comment may legally anchor to — *added* lines only.
   * Unchanged (context) lines are deliberately excluded: GitLab's discussion
   * position requires both old_line and new_line for an unchanged line, and
   * this feature only ever sends new_line, so a context-line anchor would be
   * rejected by the forge after the agent already paid to produce it.
   */
  commentableLines: number[];
  /**
   * Each commentable line's own text (the added line without its `+`), keyed by
   * the same new-file number. The anchor check in findings.ts compares it with
   * the line the agent quoted, which is what turns "a number that is legal
   * somewhere in this file" into "the line this finding is actually about".
   */
  commentableText: Record<number, string>;
}

export interface ReviewFinding {
  file: string;
  /** Line number in the file's NEW version. */
  line: number;
  severity: ReviewSeverity;
  /** Markdown body, possibly carrying a ```suggestion block. */
  comment: string;
  /**
   * The flagged added line, quoted verbatim by the agent. Optional: an agent
   * that omits it is gated exactly as before, but when it is present findings.ts
   * trusts the code over the number and re-anchors the comment to the line that
   * really holds it.
   */
  code?: string;
}
