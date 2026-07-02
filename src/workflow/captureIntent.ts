/** Step 3: ask the configured agent what a diff is *for*, in a structured, reusable shape. */

import { z } from 'zod';
import type { AgentAdapter } from '../agent/types.js';
import type { CapturedIntent } from '../types.js';

const COMMIT_MESSAGE_MAX_LENGTH = 72;

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentence description of what this change does and why' },
    branchName: { type: 'string', description: 'A short kebab-case branch name, prefixed with pipeline-worker/' },
    commitMessage: {
      type: 'string',
      maxLength: COMMIT_MESSAGE_MAX_LENGTH,
      description:
        `A single-line conventional-commit subject (e.g. "fix: handle empty diff"), max ${COMMIT_MESSAGE_MAX_LENGTH} characters. ` +
        'Used verbatim as both the git commit message and the MR/PR title — no body, bullet list, or line breaks.',
    },
  },
  required: ['summary', 'branchName', 'commitMessage'],
} as const;

/**
 * Agent output is untrusted input: validate the shape and constrain the
 * branch name to characters that are safe as a git ref and a URL segment.
 * commitMessage doubles as the MR/PR title (see openMergeRequest.ts), so it
 * must stay a single line short enough to render as one.
 */
const IntentShape = z.object({
  summary: z.string().min(1),
  branchName: z.string().regex(/^pipeline-worker\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'branchName must be pipeline-worker/<kebab-case-name>'),
  commitMessage: z
    .string()
    .min(1)
    .max(COMMIT_MESSAGE_MAX_LENGTH)
    .refine((s) => !s.includes('\n'), 'commitMessage must be a single line (it doubles as the MR/PR title)'),
});

export async function captureIntent(agent: AgentAdapter, diffText: string, worktreePath: string): Promise<CapturedIntent> {
  const prompt =
    'Read the following git diff and determine the intent behind it. ' +
    'Respond with a JSON object matching the given schema: a short summary of what changed and why, ' +
    'a kebab-case branch name prefixed with "pipeline-worker/", and a short single-line conventional-commit ' +
    `subject (max ${COMMIT_MESSAGE_MAX_LENGTH} characters, no body or bullet list) — it is used verbatim as ` +
    'the MR/PR title as well as the commit message.\n\n' +
    `\`\`\`diff\n${diffText}\n\`\`\``;

  const result = await agent.invoke({ prompt, cwd: worktreePath, jsonSchema: INTENT_SCHEMA });
  try {
    return IntentShape.parse(JSON.parse(result.text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent returned an unusable intent payload: ${message}\n--- agent output ---\n${result.text.slice(0, 2000)}`);
  }
}
