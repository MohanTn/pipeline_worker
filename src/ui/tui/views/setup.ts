/**
 * The setup guide: the shortest path from "just installed this" to a config
 * file that actually works, one question per screen with the reason for the
 * question above it.
 *
 * The step list is derived from the current answers rather than fixed, so you
 * are only asked about the forge you picked (GitLab host + token, or GitHub
 * repo + token) and only warned about `--bare` if you picked claude. Nothing
 * is written until the summary step is confirmed, so backing out with q leaves
 * the existing config untouched.
 *
 * wizardSteps() and applyAnswers() are pure and exported, so "which questions
 * does a GitHub + copilot user get, and what does that write" is a unit test
 * rather than a manual click-through.
 */

import { seg, wrap, type Line } from '../line.js';
import { moveIndex } from '../list.js';
import { sectionRow } from '../chrome.js';
import { applyKey, createInput, renderInput, type InputState } from '../textInput.js';
import { getAtPath, setAtPath, type ConfigValue } from '../configStore.js';
import { CONFIG_FIELDS, type ConfigField } from '../configSchema.js';
import { NONE, isBackKey, type Action, type RenderedView, type View } from '../view.js';
import type { SettingsIo } from './settings.js';
import type { Key } from '../keys.js';
import type { Size } from '../screen.js';
import type { PipelineWorkerConfig } from '../../../types.js';

export type Answers = Record<string, ConfigValue>;

export interface WizardStep {
  path: string;
  question: string;
  /** Why this is being asked — the part that makes the wizard a guide rather than a form. */
  help: string;
  kind: 'enum' | 'boolean' | 'string' | 'secret';
  choices?: readonly string[];
  placeholder?: string;
}

function field(path: string): ConfigField {
  const found = CONFIG_FIELDS.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`setup wizard references unknown config field ${path}`);
  return found;
}

/** A step built from the schema, so the wizard's help text and the settings editor's never drift apart. */
function stepFor(path: string, question: string, extraHelp = ''): WizardStep {
  const source = field(path);
  return {
    path,
    question,
    help: extraHelp ? `${source.doc} ${extraHelp}` : source.doc,
    kind: source.kind === 'number' ? 'string' : source.kind,
    choices: source.choices,
    placeholder: source.placeholder,
  };
}

/**
 * The questions to ask, given the answers so far. Forge and agent are asked
 * first precisely because they decide which of the later questions exist.
 */
export function wizardSteps(answers: Answers): WizardStep[] {
  const steps: WizardStep[] = [
    stepFor('forge', 'Where do your merge requests live?'),
    stepFor('agent', 'Which coding agent should do the work?'),
  ];
  if (answers.forge === 'github') {
    steps.push(stepFor('github.repo', 'Which repository?', 'Leave it empty to detect it from each repo\'s origin remote — usually the right answer.'));
    steps.push(stepFor('github.token', 'Paste a GitHub token'));
  } else {
    steps.push(stepFor('gitlab.host', 'What is your GitLab URL?'));
    steps.push(stepFor('gitlab.token', 'Paste a GitLab token'));
    steps.push(stepFor('gitlab.repoBase', 'Where do your GitLab repos live on disk?', 'Optional, but setting it once means you never set projectId again.'));
  }
  if (answers.agent === 'claude') {
    steps.push(stepFor('bareAgentMode', 'Do you sign in to claude with an API key?', 'Answer "off" if you use a Claude subscription (OAuth) — otherwise every agent turn will fail to authenticate.'));
  }
  steps.push(stepFor('review', 'Should the agent review its own merge requests?'));
  steps.push(stepFor('autoMergeOnGreen', 'Merge automatically once CI is green?'));
  return steps;
}

/** Folds the collected answers into the settings object. Untouched keys are left exactly as they were. */
export function applyAnswers(settings: Record<string, unknown>, answers: Answers): Record<string, unknown> {
  let next = settings;
  for (const [path, value] of Object.entries(answers)) next = setAtPath(next, path, value);
  return next;
}

/**
 * Seeds the wizard from the config already in force, so re-running it confirms
 * your setup rather than resetting it. forge and agent are seeded eagerly
 * because wizardSteps() branches on them; every other step is seeded from the
 * same config as it is reached (see SetupView.heldValue) — which is what stops
 * the wizard from silently flipping a deliberately-off setting like `review`
 * just because "on" happens to be the first choice on screen.
 */
export function initialAnswers(config: PipelineWorkerConfig): Answers {
  return { forge: config.forge, agent: config.agent };
}

type Phase = { kind: 'intro' } | { kind: 'step'; index: number } | { kind: 'summary' } | { kind: 'saved'; message: string; ok: boolean };

const INTRO = [
  'This walks through the handful of settings that decide whether pipeline-worker can run at all: which forge to open merge requests on, how to authenticate, and which coding agent does the work.',
  'Everything else has a working default you can tune later in Settings, where each key carries the same explanation you see here.',
  'Nothing is written until you confirm at the end. Press q at any point to leave your current config untouched.',
];

export class SetupView implements View {
  private phase: Phase = { kind: 'intro' };
  private answers: Answers;
  private readonly config: PipelineWorkerConfig;
  private input: InputState = createInput('');
  private choiceIndex = 0;

  constructor(private readonly io: SettingsIo) {
    this.config = io.resolve();
    this.answers = initialAnswers(this.config);
  }

  /**
   * What a step should start on: the answer already given this run, else the
   * value currently in force. Secrets are excluded — a stored token must never
   * be echoed back into an editable field.
   */
  private heldValue(step: WizardStep): ConfigValue | undefined {
    if (step.path in this.answers) return this.answers[step.path];
    if (step.kind === 'secret') return undefined;
    const current = getAtPath(this.config as unknown as Record<string, unknown>, step.path);
    return typeof current === 'string' || typeof current === 'number' || typeof current === 'boolean' ? current : undefined;
  }

  private steps(): WizardStep[] {
    return wizardSteps(this.answers);
  }

  private currentStep(): WizardStep | undefined {
    return this.phase.kind === 'step' ? this.steps()[this.phase.index] : undefined;
  }

  /** Choices a step offers as a picker: enum values, or on/off for a boolean. */
  private choicesFor(step: WizardStep): readonly string[] {
    return step.kind === 'boolean' ? ['on', 'off'] : (step.choices ?? []);
  }

  private isPicker(step: WizardStep): boolean {
    return step.kind === 'boolean' || step.kind === 'enum';
  }

  /** Moves onto `index`, seeding the picker cursor or the text field from the answer already held for that step. */
  private enterStep(index: number): void {
    const steps = this.steps();
    if (index >= steps.length) {
      this.phase = { kind: 'summary' };
      return;
    }
    const step = steps[index];
    this.phase = { kind: 'step', index };
    const held = this.heldValue(step);
    if (this.isPicker(step)) {
      const asChoice = step.kind === 'boolean' ? (held ? 'on' : 'off') : String(held ?? '');
      this.choiceIndex = Math.max(0, this.choicesFor(step).indexOf(asChoice));
    } else {
      this.input = createInput(String(held ?? ''));
    }
  }

  private recordAnswer(step: WizardStep): void {
    if (this.isPicker(step)) {
      const choice = this.choicesFor(step)[this.choiceIndex];
      this.answers[step.path] = step.kind === 'boolean' ? choice === 'on' : choice;
      return;
    }
    this.answers[step.path] = this.input.value.trim();
  }

  private save(): void {
    const result = this.io.save(applyAnswers(this.io.read(), this.answers));
    this.phase = result.ok
      ? { kind: 'saved', ok: true, message: 'Saved. Open Settings any time to tune the rest — every key there explains itself.' }
      : { kind: 'saved', ok: false, message: `Could not save: ${result.error}` };
  }

  private renderIntro(width: number): RenderedView {
    const body: Line[] = [[seg('Set up pipeline-worker', { bold: true, role: 'sky' })], []];
    for (const paragraph of INTRO) {
      for (const text of wrap(paragraph, width)) body.push([seg(text, { role: 'overlay1' })]);
      body.push([]);
    }
    return { title: 'setup guide', body, hints: '⏎ begin · q back' };
  }

  private renderStep(step: WizardStep, index: number, width: number): RenderedView {
    const total = this.steps().length;
    const body: Line[] = [
      [seg(`Step ${index + 1} of ${total}`, { role: 'overlay1' })],
      [seg(step.question, { bold: true })],
      [],
    ];
    for (const text of wrap(step.help, width)) body.push([seg(text, { role: 'overlay1' })]);
    body.push([], sectionRow(step.path, width));

    if (this.isPicker(step)) {
      this.choicesFor(step).forEach((choice, i) => {
        const selected = i === this.choiceIndex;
        body.push([seg(selected ? ' ❯ ' : '   ', { role: 'sky', bold: true }), seg(choice, { bold: selected, role: selected ? 'sky' : undefined })]);
      });
      return { title: 'setup guide', body, hints: '↑↓ choose · ⏎ next · esc back · q quit' };
    }
    body.push([seg('  '), ...renderInput(this.input, step.placeholder ?? '(leave empty to skip)')]);
    return { title: 'setup guide', body, hints: '⏎ next · esc back · ctrl-u clear · q quit' };
  }

  private renderSummary(width: number): RenderedView {
    const body: Line[] = [[seg('Ready to write these to your config file:', { bold: true })], []];
    for (const step of this.steps()) {
      const value = this.answers[step.path];
      const shown = step.kind === 'secret' ? (value ? '••••••••' : '(unset)') : String(value ?? '') || '(unset)';
      body.push([seg(`  ${step.path.padEnd(22)}`, { role: 'overlay1' }), seg(shown)]);
    }
    body.push([], ...wrap('Keys you were not asked about keep their current values.', width).map((text) => [seg(text, { role: 'overlay1' })]));
    return { title: 'setup guide', body, hints: '⏎ save · esc back · q cancel' };
  }

  render(inner: Size): RenderedView {
    const phase = this.phase;
    if (phase.kind === 'intro') return this.renderIntro(inner.columns);
    if (phase.kind === 'step') return this.renderStep(this.steps()[phase.index], phase.index, inner.columns);
    if (phase.kind === 'summary') return this.renderSummary(inner.columns);
    const body: Line[] = wrap(phase.message, inner.columns).map((text) => [seg(text, { role: phase.ok ? 'green' : 'red' })]);
    return { title: 'setup guide', body, hints: '⏎ done' };
  }

  // fallow-ignore-next-line complexity
  private onStepKey(step: WizardStep, index: number, key: Key): Action {
    if (key.name === 'escape') {
      if (index === 0) this.phase = { kind: 'intro' };
      else this.enterStep(index - 1);
      return NONE;
    }
    if (key.name === 'enter') {
      this.recordAnswer(step);
      this.enterStep(index + 1);
      return NONE;
    }
    if (this.isPicker(step)) {
      if (key.name === 'up') this.choiceIndex = moveIndex(this.choiceIndex, -1, this.choicesFor(step).length);
      else if (key.name === 'down') this.choiceIndex = moveIndex(this.choiceIndex, 1, this.choicesFor(step).length);
      else if (isBackKey(key)) return { type: 'pop' };
      return NONE;
    }
    const result = applyKey(this.input, key);
    if (result.handled) this.input = result.state;
    // 'q' is a legal character in a URL or a token, so a text step can only be
    // left with esc — quitting from here would eat the keystroke instead.
    return NONE;
  }

  // fallow-ignore-next-line complexity
  onKey(key: Key): Action {
    const phase = this.phase;
    if (phase.kind === 'step') return this.onStepKey(this.steps()[phase.index], phase.index, key);
    if (phase.kind === 'saved') return key.name === 'enter' || isBackKey(key) ? { type: 'pop' } : NONE;
    if (phase.kind === 'summary') {
      // esc steps back into the questions; q abandons the whole wizard.
      if (key.name === 'escape') this.enterStep(this.steps().length - 1);
      else if (isBackKey(key)) return { type: 'pop' };
      else if (key.name === 'enter') this.save();
      return NONE;
    }
    if (isBackKey(key)) return { type: 'pop' };
    if (key.name === 'enter') this.enterStep(0);
    return NONE;
  }
}
