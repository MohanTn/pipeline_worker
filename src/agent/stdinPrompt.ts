/**
 * Writes a prompt to a spawned child's stdin and closes it. Used instead of
 * passing the prompt as a CLI argument because captureIntent.ts embeds a
 * full git diff in the prompt, and Linux caps a single exec() argument at
 * ~128KB (MAX_ARG_STRLEN) — a large diff trips E2BIG before the CLI starts.
 *
 * If the child exits (or never reads stdin) before this write lands, Node
 * emits EPIPE as an 'error' event on the stdin stream, which is unhandled by
 * default and crashes the process. The real failure already surfaces via the
 * execFile promise rejecting (non-zero exit, timeout, etc.), so that error is
 * swallowed here rather than duplicated.
 */
export function writePromptToStdin(stdin: NodeJS.WritableStream, prompt: string): void {
  stdin.on('error', () => {});
  stdin.end(prompt);
}
