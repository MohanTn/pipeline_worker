/**
 * Splits a unified diff into review-sized chunks (step 1 of the review
 * pipeline). Two jobs, both of which have to be right for a line-anchored
 * comment to land:
 *
 * 1. *Chunking* — a large MR/PR's patch does not fit in one agent turn, so it
 *    is cut on file boundaries first and only split mid-file when a single
 *    file exceeds the char budget. Every chunk carries its file name and
 *    language, so a chunk is self-contained context.
 * 2. *Line numbering* — the forge APIs anchor a comment to a line number in
 *    the file's NEW version, which appears nowhere in the raw patch text. It
 *    is derived here by walking each `@@ -a,b +c,d @@` header and counting
 *    added/context lines, then rendered into the chunk body so the agent can
 *    only ever quote a number that actually exists.
 *
 * Hand-rolled rather than a diff-parsing dependency: this is ~100 lines and
 * runtime dependencies are deliberately minimal (see CLAUDE.md).
 */

import type { DiffChunk } from './types.js';

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript (React)',
  mts: 'TypeScript',
  cts: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript (React)',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  php: 'PHP',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  cs: 'C#',
  c: 'C',
  h: 'C/C++ header',
  cpp: 'C++',
  hpp: 'C++ header',
  sh: 'Shell',
  bash: 'Shell',
  sql: 'SQL',
  yml: 'YAML',
  yaml: 'YAML',
  json: 'JSON',
  md: 'Markdown',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
};

export function detectLanguage(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return LANGUAGES[extension] ?? 'text';
}

/** One rendered row of a chunk body: the raw diff line plus the new-file number it belongs to, when it has one. */
interface Row {
  text: string;
  /** New-file line number; absent for removed lines and hunk headers. */
  line?: number;
  /** Added lines are the only ones a comment may anchor to (see DiffChunk.commentableLines). */
  commentable: boolean;
  isHunkHeader: boolean;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function renderRow(row: Row): string {
  return `${(row.line !== undefined ? String(row.line) : '-').padStart(6)} | ${row.text}`;
}

/** The path on the diff's new side, or undefined for a deleted/binary/mode-only section. */
function newPathOf(section: string[]): string | undefined {
  if (section.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))) return undefined;
  const plus = section.find((line) => line.startsWith('+++ '));
  if (!plus) return undefined;
  const path = plus.slice(4).trim();
  if (path === '/dev/null') return undefined;
  return path.startsWith('b/') ? path.slice(2) : path;
}

/** Walks one file's hunks, assigning each added/context line its number in the new file. */
function rowsOf(section: string[]): Row[] {
  const rows: Row[] = [];
  let newLine = 0;
  let inHunk = false;
  for (const text of section) {
    const header = HUNK_HEADER.exec(text);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      rows.push({ text, commentable: false, isHunkHeader: true });
      continue;
    }
    if (!inHunk) continue; // diff/index/---/+++ preamble
    if (text.startsWith('\\')) continue; // "\ No newline at end of file"
    if (text.startsWith('-')) {
      rows.push({ text, commentable: false, isHunkHeader: false });
    } else if (text.startsWith('+')) {
      rows.push({ text, line: newLine, commentable: true, isHunkHeader: false });
      newLine += 1;
    } else if (text.startsWith(' ')) {
      // git renders a blank context line as a single space, so a truly empty
      // string is only ever the split artifact of the patch's trailing
      // newline — counting it would invent a line past the end of the file.
      rows.push({ text, line: newLine, commentable: false, isHunkHeader: false });
      newLine += 1;
    }
  }
  return rows;
}

/** Packs one file's rows into chunks no larger than maxChars, repeating the enclosing hunk header whenever a split lands mid-hunk. */
function packRows(path: string, rows: Row[], maxChars: number): DiffChunk[] {
  const language = detectLanguage(path);
  const chunks: DiffChunk[] = [];
  let current: Row[] = [];
  let size = 0;
  let lastHeader: Row | undefined;

  const flush = (): void => {
    if (!current.some((row) => !row.isHunkHeader)) return; // header-only remainder carries no code to review
    chunks.push({
      path,
      language,
      body: current.map(renderRow).join('\n'),
      commentableLines: current.filter((row) => row.commentable).map((row) => row.line as number),
    });
  };

  for (const row of rows) {
    const cost = renderRow(row).length + 1;
    if (current.length > 0 && size + cost > maxChars) {
      flush();
      current = lastHeader && !row.isHunkHeader ? [lastHeader] : [];
      size = current.reduce((total, kept) => total + renderRow(kept).length + 1, 0);
    }
    if (row.isHunkHeader) lastHeader = row;
    current.push(row);
    size += cost;
  }
  flush();
  return chunks;
}

/**
 * Chunks a unified diff. Sections with nothing a comment could anchor to —
 * binary files, pure deletions, mode-only changes — are dropped entirely
 * rather than sent to the agent, since any finding they produced would be
 * unpostable anyway.
 */
export function chunkDiff(patch: string, maxChars: number): DiffChunk[] {
  const lines = patch.split('\n');
  const chunks: DiffChunk[] = [];
  let section: string[] = [];

  const finishSection = (): void => {
    if (section.length === 0) return;
    const path = newPathOf(section);
    if (path) chunks.push(...packRows(path, rowsOf(section), Math.max(1, maxChars)));
    section = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) finishSection();
    if (section.length > 0 || line.startsWith('diff --git ')) section.push(line);
  }
  finishSection();

  return chunks.filter((chunk) => chunk.commentableLines.length > 0);
}
