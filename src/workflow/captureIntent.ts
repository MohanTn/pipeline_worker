/** Step 3: ask the configured agent what a diff is *for*, in a structured, reusable shape. */

import { z } from 'zod';
import type { AgentAdapter } from '../agent/types.js';
import type { CapturedIntent } from '../types.js';

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentence description of what this change does and why' },
    branchName: { type: 'string', description: 'A short kebab-case branch name, prefixed with pipeline-worker/' },
    commitMessage: { type: 'string', description: 'A conventional-commit-style commit message for this change' },
  },
  required: ['summary', 'branchName', 'commitMessage'],
} as const;

/**
 * Agent output is untrusted input: validate the shape and constrain the
 * branch name to characters that are safe as a git ref and a URL segment.
 */
const IntentShape = z.object({
  summary: z.string().min(1),
  branchName: z.string().regex(/^pipeline-worker\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'branchName must be pipeline-worker/<kebab-case-name>'),
  commitMessage: z.string().min(1),
});

export async function captureIntent(agent: AgentAdapter, diffText: string, worktreePath: string): Promise<CapturedIntent> {
  const prompt =
    'Read the following git diff and determine the intent behind it. ' +
    'Respond with a JSON object matching the given schema: a short summary of what changed and why, ' +
    'a kebab-case branch name prefixed with "pipeline-worker/", and a conventional-commit-style commit message.\n\n' +
    `\`\`\`diff\n${diffText}\n\`\`\``;

  const result = await agent.invoke({ prompt, cwd: worktreePath, jsonSchema: INTENT_SCHEMA });
  try {
    return IntentShape.parse(JSON.parse(result.text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent returned an unusable intent payload: ${message}\n--- agent output ---\n${result.text.slice(0, 2000)}`);
  }
}
