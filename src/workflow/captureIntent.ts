/** Step 3: ask the configured agent what a diff is *for*, in a structured, reusable shape. */

import { z } from 'zod';
import { diffTextSinceRef } from '../git/diff.js';
import { truncateToBudget } from '../agent/promptText.js';
import type { AgentAdapter, AgentUsage } from '../agent/types.js';
import type { CapturedIntent } from '../types.js';
import { note, noteSession } from '../ui/steps.js';

const COMMIT_MESSAGE_MAX_LENGTH = 72;

/**
 * The only tool this step gets: reading files — for the new/untracked files a
 * diff cannot show (see captureIntent, which embeds the diff itself). No
 * Write/Edit (this step reports intent, it must not touch the worktree the
 * later apply/commit/checkout steps depend on) and, deliberately, no Bash: a
 * step that can run one command can run another, and pipeline-worker runs the
 * one command this step actually needs (`git diff`) on its behalf. The claude
 * adapter turns this list into `--tools Read` as well as `--allowedTools Read`,
 * so the turn has no shell to reach for.
 */
const READ_ONLY_TOOLS = ['Read'];

/**
 * Cap on the embedded diff. A generated lockfile or a vendored bundle can run
 * to megabytes, which would swamp the model's context (and, before the cap
 * existed, was the reason this step listed file names instead of embedding a
 * diff at all). Truncation is middle-out, marked, and the prompt tells the
 * agent it may Read a file whose diff was cut.
 */
const MAX_INTENT_DIFF_CHARS = 20_000;

/** Replaces the agent's default system prompt: this turn classifies a change set and returns JSON, nothing else. */
const INTENT_SYSTEM =
  'You summarize a git diff as structured JSON. You may only read files — you never modify the ' +
  'repository and never run commands. Answer with the requested JSON object and nothing else.';

const RISK_CRITERIA =
  'low: the change is isolated to independent components with a small blast radius. ' +
  'medium: the change touches a shared/dependent component, but that component is well covered by existing unit tests. ' +
  "high: the change touches existing/critical code paths and needs a human reviewer's attention before merging.";

const CHANGE_TYPES = ['feature', 'bugfix', 'chore'] as const;

const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', description: 'One short sentence, no line breaks: why this change exists / what problem it solves.' },
    summary: { type: 'string', description: 'One or two sentences (single line, no line breaks) on what this change does and why' },
    changeType: { type: 'string', enum: [...CHANGE_TYPES], description: 'The kind of change, used to compose the branch name.' },
    branchSlug: { type: 'string', description: 'A short kebab-case slug describing the change — no prefix, path, or ticket id.' },
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
  required: ['intent', 'summary', 'changeType', 'branchSlug', 'commitMessage', 'fileChanges', 'risk', 'riskReason', 'testScenarios'],
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
 * Agent output is untrusted input: validate the shape and constrain
 * branchSlug to characters that are safe as a git ref segment and a URL
 * segment (the full branch name — prefix, ticket, slug — is composed and
 * re-validated by git/branchName.ts once orchestrate.ts knows the
 * configured branchPattern and any --ticket). commitMessage doubles as the
 * MR/PR title (see openMergeRequest.ts), so it must stay a single line
 * short enough to render as one.
 */
const IntentShape = z.object({
  intent: singleLine('intent'),
  summary: singleLine('summary'),
  changeType: z.enum(CHANGE_TYPES),
  branchSlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'branchSlug must be a kebab-case slug with no prefix, path, or ticket id'),
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
 * The prompt carries the change itself: pipeline-worker runs `git diff
 * <baseRef>` in the worktree and embeds the patch, capped at
 * MAX_INTENT_DIFF_CHARS. The agent therefore judges the *delta* — what the
 * change did — rather than the post-change state of each file, which is what
 * it would see if it could only Read them, and it needs no shell to get there
 * (see READ_ONLY_TOOLS). Untracked/new files never appear in a diff, so `Read`
 * stays available for those — and they are named in the prompt as files the
 * agent must open (see filesMissingFromDiff).
 *
 * Reading the diff here is best-effort: a worktreePath that isn't a git repo,
 * or a baseRef git can't resolve, degrades to a note plus the file list alone
 * (the agent can still Read what it needs) rather than failing the run at a
 * step whose whole job is to name things.
 *
 * `model` (config's `intentModel`, default "haiku" — see config/loader.ts)
 * lets a lighter model handle this step to keep its token cost down, since
 * naming a branch/commit/summary from a diff needs no deep reasoning.
 * Each adapter maps it onto its own CLI's model flag (copilot translates
 * Claude aliases like "haiku" to its own model names).
 * The CI-fix path (watchPipeline.ts) deliberately never sets a model override
 * — fixing a real failing build needs the stronger default model.
 *
 * `baseRef` defaults to `HEAD`, matching a normal run's uncommitted diff. The
 * `resume` branch-adoption path (adoptBranch.ts) passes a fixed merge-base
 * commit instead (see git/commit.ts's mergeBase), since there the change set
 * is already committed on the branch — `git diff HEAD` there would show
 * nothing.
 */
/** captureIntent's return: the validated intent plus the turn's best-effort token usage, so the caller can record the spend against its run state. */
export interface IntentCapture {
  intent: CapturedIntent;
  usage?: AgentUsage;
}

/** The embedded patch, or '' when git can't produce one here (already noted). */
async function readIntentDiff(worktreePath: string, baseRef: string): Promise<string> {
  try {
    const diffText = (await diffTextSinceRef(worktreePath, baseRef)).trim();
    return truncateToBudget(diffText, MAX_INTENT_DIFF_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`could not read the diff for intent capture (${message}) — the agent will read the changed files instead`);
    return '';
  }
}

/**
 * Which of the changed files the patch does not cover — untracked/new files,
 * which git omits from a diff entirely. Named explicitly in the prompt because
 * "new files do not appear in a diff, Read them if you need to" is not enough
 * on its own: verified against the real CLI, an agent handed a patch plus that
 * sentence summarized only the files it could see and left the new one out of
 * its per-file breakdown.
 */
export function filesMissingFromDiff(files: string[], diffText: string): string[] {
  return files.filter((file) => !diffText.includes(`b/${file}`) && !diffText.includes(`a/${file}`));
}

/** The diff block for the prompt, or the read-the-files instruction when there is no diff to show. */
function describeChange(files: string[], diffText: string, baseRef: string): string {
  if (diffText.length === 0) {
    return `Read the ones you need (the change is already applied, on top of ${baseRef}) and determine the intent behind the change as a whole. `;
  }
  const missing = filesMissingFromDiff(files, diffText);
  const readInstruction =
    missing.length > 0
      ? `\n\nThese changed files are new, so the patch above does not contain them — Read each one before answering: ${missing.join(', ')}.`
      : '';
  return (
    `\n\nHere is that change as a patch (\`git diff ${baseRef}\`). Read any file whose diff below is marked truncated:\n` +
    `--- begin diff ---\n${diffText}\n--- end diff ---${readInstruction}\n\n` +
    'Determine the intent behind the change as a whole, covering every file listed above in your per-file breakdown. '
  );
}

export async function captureIntent(agent: AgentAdapter, files: string[], worktreePath: string, model: string, baseRef = 'HEAD'): Promise<IntentCapture> {
  const diffText = await readIntentDiff(worktreePath, baseRef);
  const prompt =
    'The following files changed in this git worktree (which is your current working directory):\n' +
    files.map((file) => `- ${file}`).join('\n') +
    describeChange(files, diffText, baseRef) +
    'Skip files whose content is generated or vendored. ' +
    'Respond with a JSON object matching the given schema: why this change exists, a short summary of what changed, ' +
    `the kind of change (${CHANGE_TYPES.join('/')}), a short kebab-case branch slug describing the change ` +
    '(no prefix, path, or ticket id — those are added separately), a short single-line conventional-commit ' +
    `subject (max ${COMMIT_MESSAGE_MAX_LENGTH} characters, no body or bullet list, used verbatim as the MR/PR title), ` +
    'a one-line summary per changed file, a risk level with a one-line justification ' +
    `(${RISK_CRITERIA}), and the concrete test scenarios a reviewer should check before merging.`;

  const result = await agent.invoke({
    prompt,
    cwd: worktreePath,
    systemPrompt: INTENT_SYSTEM,
    jsonSchema: INTENT_SCHEMA,
    model,
    permissionMode: 'default',
    allowedTools: READ_ONLY_TOOLS,
  });
  noteSession(result, worktreePath);
  try {
    return { intent: IntentShape.parse(JSON.parse(result.text)), usage: result.usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`agent returned an unusable intent payload: ${message}\n--- agent output ---\n${result.text.slice(0, 2000)}`);
  }
}
