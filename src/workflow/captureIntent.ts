/** Step 3: ask the configured agent what a diff is *for*, in a structured, reusable shape. */

import { z } from 'zod';
import type { AgentAdapter } from '../agent/types.js';
import type { CapturedIntent } from '../types.js';

const COMMIT_MESSAGE_MAX_LENGTH = 72;

/**
 * Naming a branch/commit/summary from a diff needs no deep reasoning, so a
 * lighter model keeps this step's token cost down. Adapters that don't
 * support per-invocation model selection (e.g. copilot) just ignore this.
 * The CI-fix path (watchPipeline.ts) deliberately does NOT set this — fixing
 * a real failing build needs the stronger default model.
 */
const INTENT_MODEL = 'haiku';

/**
 * Read-only tools the agent may use to inspect the change set itself (see
 * captureIntent below): `Read` for new/untracked files (`git diff` shows
 * nothing for those), `Bash(git diff:*)` for modified tracked files, and
 * `Grep`/`Glob` for broader repo context when judging risk or test
 * scenarios. Deliberately excludes Write/Edit and any git subcommand that
 * can mutate state (commit, checkout, reset, ...) — this step only reports
 * intent, it must not be able to change the worktree the later
 * apply/commit/checkout steps depend on.
 */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)'];

const RISK_CRITERIA =
  'low: the change is isolated to independent components with a small blast radius. ' +
  'medium: the change touches a shared/dependent component, but that component is well covered by existing unit tests. ' +
  "high: the change touches existing/critical code paths and needs a human reviewer's attention before merging.";

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: 'One short sentence, no line breaks: why this change exists / what problem it solves.' },
    summary: { type: 'string', description: 'One or two sentences (single line, no line breaks) on what this change does and why' },
    branchName: { type: 'string', description: 'A short kebab-case branch name, prefixed with pipeline-worker/' },
    commitMessage: {
      type: 'string',
      maxLength: COMMIT_MESSAGE_MAX_LENGTH,
      description:
        `A single-line conventional-commit subject (e.g. "fix: handle empty diff"), max ${COMMIT_MESSAGE_MAX_LENGTH} characters. ` +
        'Used verbatim as both the git commit message and the MR/PR title — no body, bullet list, or line breaks.',
    },
    fileChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'The file path (single line).' },
          summary: { type: 'string', description: 'A single-line summary of what changed in that file.' },
        },
        required: ['file', 'summary'],
      },
      description: 'One entry per file touched in the diff, each a single-line summary of what changed in that file.',
    },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], description: RISK_CRITERIA },
    riskReason: { type: 'string', description: 'One short sentence (no line breaks) justifying the risk level.' },
    testScenarios: {
      type: 'array',
      items: { type: 'string', description: 'A single-line test scenario a reviewer should verify before merging.' },
      description: 'Concrete test scenarios (each a single line) a reviewer should verify before merging.',
    },
  },
  required: ['intent', 'summary', 'branchName', 'commitMessage', 'fileChanges', 'risk', 'riskReason', 'testScenarios'],
} as const;

/**
 * Every one of these fields is rendered by openMergeRequest.ts's
 * buildDescription() as a single inline line or bullet, so — like
 * commitMessage — none of them may contain a newline, or they'd break the
 * MR/PR description's formatting.
 */
function singleLine(fieldName: string) {
  return z
    .string()
    .min(1)
    .refine((s) => !s.includes('\n'), `${fieldName} must be a single line`);
}

/**
 * Agent output is untrusted input: validate the shape and constrain the
 * branch name to characters that are safe as a git ref and a URL segment.
 * commitMessage doubles as the MR/PR title (see openMergeRequest.ts), so it
 * must stay a single line short enough to render as one.
 */
const IntentShape = z.object({
  intent: singleLine('intent'),
  summary: singleLine('summary'),
  branchName: z.string().regex(/^pipeline-worker\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'branchName must be pipeline-worker/<kebab-case-name>'),
  commitMessage: z
    .string()
    .min(1)
    .max(COMMIT_MESSAGE_MAX_LENGTH)
    .refine((s) => !s.includes('\n'), 'commitMessage must be a single line (it doubles as the MR/PR title)'),
  fileChanges: z.array(z.object({ file: singleLine('fileChanges[].file'), summary: singleLine('fileChanges[].summary') })).min(1),
  risk: z.enum(['low', 'medium', 'high']),
  riskReason: singleLine('riskReason'),
  testScenarios: z.array(singleLine('testScenarios[]')).min(1),
});

/**
 * Rather than embedding the (potentially huge — generated lockfiles, binary
 * assets, etc.) diff text in the prompt, this only lists which files
 * changed and lets the agent read each one's diff itself with its own
 * tools, scoped to `worktreePath` (the isolated worktree the change was
 * already applied into by orchestrate.ts's "Applying your changes" step).
 * That keeps the prompt itself small and constant-size regardless of how
 * large any individual file's diff is, and lets the agent skip files it
 * judges irrelevant to intent (lockfiles, generated assets) instead of
 * paying to read them.
 */
export async function captureIntent(agent: AgentAdapter, files: string[], worktreePath: string): Promise<CapturedIntent> {
  const prompt =
    'The following files changed in this git worktree (which is your current working directory):\n' +
    files.map((file) => `- ${file}`).join('\n') +
    '\n\nUse your tools to inspect what changed: `git diff HEAD -- <file>` (or `git diff HEAD` for everything at ' +
    "once) for a file that already existed, or Read it directly if it's a new file git diff won't show. " +
    'Then determine the intent behind the change as a whole. ' +
    'Respond with a JSON object matching the given schema: why this change exists, a short summary of what changed, ' +
    'a kebab-case branch name prefixed with "pipeline-worker/", a short single-line conventional-commit ' +
    `subject (max ${COMMIT_MESSAGE_MAX_LENGTH} characters, no body or bullet list, used verbatim as the MR/PR title), ` +
    'a one-line summary per changed file, a risk level with a one-line justification ' +
    `(${RISK_CRITERIA}), and the concrete test scenarios a reviewer should check before merging.`;

  const result = await agent.invoke({
    prompt,
    cwd: worktreePath,
    jsonSchema: INTENT_SCHEMA,
    model: INTENT_MODEL,
    permissionMode: 'default',
    allowedTools: READ_ONLY_TOOLS,
  });
  try {
    return IntentShape.parse(JSON.parse(result.text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent returned an unusable intent payload: ${message}\n--- agent output ---\n${result.text.slice(0, 2000)}`);
  }
}
