/**
 * The run's step tree: a pure in-memory data model of every workflow step,
 * its status, timing, attempt counters, and best-effort token spend. This is
 * what the renderers (ui/renderer.ts, ui/treeRenderer.ts) draw from — it
 * contains no ANSI, no console access, and never throws: an unknown step id
 * is auto-added as a top-level node rather than crashing the workflow (the
 * UI must never kill a run — see CLAUDE.md's never-throw contracts).
 *
 * Step identity is a string id ('capture', 'ci-watch', 'ci-watch/fix-2').
 * Ids replaced the old hard-coded stage numbers ([7/14]) because the watch
 * loop grows children dynamically — fix attempts, rebases — and stable ids
 * don't need renumbering when a step is inserted.
 */

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

/** The whole run's terminal status, shown in the header line. */
export type RunStatus = 'running' | 'done' | 'failed' | 'escalated' | 'interrupted';

/**
 * How one step's prompt/completion spend breaks down, summed across every agent
 * turn attributed to it. Mirrors the reported half of agent/types.ts's
 * AgentUsage; every field is optional and absent means unknown, never zero (an
 * adapter whose CLI reports no usage contributes none of them).
 */
export interface TokenSplit {
  /** Prompt-side tokens, with cacheReadTokens/cacheWriteTokens folded in. */
  inputTokens?: number;
  /** The share of inputTokens served from the prompt cache rather than processed fresh. */
  cacheReadTokens?: number;
  /** The share of inputTokens written into the prompt cache. */
  cacheWriteTokens?: number;
  outputTokens?: number;
}

export interface StepNode {
  /** Unique within the tree; children conventionally use 'parent/child' ids. */
  id: string;
  /** Short name in the left column: 'capture', 'ci-watch', 'fix 2'. */
  label: string;
  /** Right-hand description; mutable while the step runs (phase updates). */
  detail: string;
  status: StepStatus;
  /** Epoch ms when the step entered 'running'. */
  startedAt?: number;
  /** Set when the step finishes ('done'/'failed'). */
  durationMs?: number;
  /** Best-effort agent tokens attributed to this step; absent means unknown, never zero. */
  tokens?: number;
  /** The input/cache/output split behind `tokens`, summed over this step's turns; absent when the adapter reported only a total (or nothing). */
  usage?: TokenSplit;
  /** Rendered as 'attempt N/M' when both are present. */
  attempt?: number;
  maxAttempts?: number;
  children: StepNode[];
}

/** What a skeleton declares per step up front — everything else starts pending/empty. */
export interface StepSeed {
  id: string;
  label: string;
  detail: string;
}

export interface RunHeader {
  /** The run's name: initially generic, updated once intent names the branch. */
  title: string;
  /** Short worktree identifier (last hex chars of the temp-branch uuid). */
  worktreeShortId?: string;
  status: RunStatus;
}

export type TreeEvent =
  | { kind: 'add'; node: StepNode }
  | { kind: 'start'; node: StepNode }
  | { kind: 'finish'; node: StepNode }
  | { kind: 'update'; node: StepNode }
  | { kind: 'tokens'; node: StepNode }
  | { kind: 'header' };

/** One renderable row of the flattened tree: the node, its depth, and whether it is the last sibling at each ancestor level (for branch glyphs). */
export interface TreeRow {
  node: StepNode;
  depth: number;
  /** isLast[d] — whether the chain through this row is the final sibling at depth d. Drives '├─' vs '└─' and '│' vs ' ' continuation. */
  isLast: boolean[];
}

/** Adds one reported figure onto a running one, leaving the field untouched when the incoming side is unknown or nonsense (absence must not read as zero). */
function sumField(current: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined || !Number.isFinite(incoming) || incoming < 0) return current;
  return (current ?? 0) + incoming;
}

/** Sums two splits field by field. Returns the current split unchanged when the incoming one reports nothing at all, so a usage-less turn never creates an all-zero breakdown. */
function mergeSplit(current: TokenSplit | undefined, incoming: TokenSplit): TokenSplit | undefined {
  const merged: TokenSplit = {
    inputTokens: sumField(current?.inputTokens, incoming.inputTokens),
    cacheReadTokens: sumField(current?.cacheReadTokens, incoming.cacheReadTokens),
    cacheWriteTokens: sumField(current?.cacheWriteTokens, incoming.cacheWriteTokens),
    outputTokens: sumField(current?.outputTokens, incoming.outputTokens),
  };
  return Object.values(merged).some((value) => value !== undefined) ? merged : current;
}

export class RunTree {
  readonly roots: StepNode[] = [];
  readonly header: RunHeader;
  private readonly index = new Map<string, StepNode>();
  /** Tokens spent before this tree existed (a resumed run's persisted total) — folded into totalTokens(). */
  private seededTokens = 0;

  constructor(
    skeleton: StepSeed[],
    header: { title: string; worktreeShortId?: string },
    private readonly onChange: (event: TreeEvent) => void,
  ) {
    this.header = { ...header, status: 'running' };
    for (const seed of skeleton) this.insert(undefined, seed);
  }

  private insert(parent: StepNode | undefined, seed: StepSeed, extras: Partial<StepNode> = {}): StepNode {
    const node: StepNode = { ...seed, status: 'pending', children: [], ...extras };
    (parent ? parent.children : this.roots).push(node);
    this.index.set(node.id, node);
    return node;
  }

  get(id: string): StepNode | undefined {
    return this.index.get(id);
  }

  /**
   * The never-throw guarantee: any operation on an id nobody declared falls
   * back to materializing that id as a fresh top-level node, so the workflow
   * keeps narrating instead of dying on a UI bookkeeping mismatch.
   */
  private getOrAdd(id: string): StepNode {
    const existing = this.index.get(id);
    if (existing) return existing;
    const node = this.insert(undefined, { id, label: id, detail: '' });
    this.onChange({ kind: 'add', node });
    return node;
  }

  /** Adds a child under parentId (or top-level when parentId is undefined). Adding an id that already exists is a no-op returning the existing node. */
  add(parentId: string | undefined, seed: StepSeed, extras: Partial<StepNode> = {}): StepNode {
    const existing = this.index.get(seed.id);
    if (existing) return existing;
    const parent = parentId === undefined ? undefined : this.getOrAdd(parentId);
    const node = this.insert(parent, seed, extras);
    this.onChange({ kind: 'add', node });
    return node;
  }

  start(id: string, patch: Partial<Pick<StepNode, 'detail' | 'attempt' | 'maxAttempts'>> = {}): StepNode {
    const node = this.getOrAdd(id);
    node.status = 'running';
    node.startedAt = Date.now();
    node.durationMs = undefined;
    if (patch.detail !== undefined) node.detail = patch.detail;
    if (patch.attempt !== undefined) node.attempt = patch.attempt;
    if (patch.maxAttempts !== undefined) node.maxAttempts = patch.maxAttempts;
    this.onChange({ kind: 'start', node });
    return node;
  }

  finish(id: string, status: 'done' | 'failed' | 'skipped', patch: Partial<Pick<StepNode, 'detail'>> = {}): StepNode {
    const node = this.getOrAdd(id);
    node.status = status;
    if (node.startedAt !== undefined && status !== 'skipped') node.durationMs = Date.now() - node.startedAt;
    if (patch.detail !== undefined) node.detail = patch.detail;
    this.onChange({ kind: 'finish', node });
    return node;
  }

  update(id: string, patch: Partial<Pick<StepNode, 'detail' | 'attempt' | 'maxAttempts'>>): StepNode {
    const node = this.getOrAdd(id);
    if (patch.detail !== undefined) node.detail = patch.detail;
    if (patch.attempt !== undefined) node.attempt = patch.attempt;
    if (patch.maxAttempts !== undefined) node.maxAttempts = patch.maxAttempts;
    this.onChange({ kind: 'update', node });
    return node;
  }

  /** `split` is optional: an adapter that reports only a total (or a claude envelope missing the usage fields) still gets its spend counted, just without the breakdown. */
  addTokens(id: string, tokens: number, split?: TokenSplit): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const node = this.getOrAdd(id);
    node.tokens = (node.tokens ?? 0) + tokens;
    if (split) node.usage = mergeSplit(node.usage, split);
    this.onChange({ kind: 'tokens', node });
  }

  /** Registers tokens spent before this tree existed (a resumed run's persisted total). */
  seedTokens(tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    this.seededTokens += tokens;
    this.onChange({ kind: 'header' });
  }

  setHeader(patch: Partial<RunHeader>): void {
    Object.assign(this.header, patch);
    this.onChange({ kind: 'header' });
  }

  /** The run's total spend: every node's tokens plus any seeded pre-resume total. */
  totalTokens(): number {
    let total = this.seededTokens;
    for (const node of this.index.values()) total += node.tokens ?? 0;
    return total;
  }

  /** Every step that reported a token split, in display order — the rows of the settled run's per-turn usage table. */
  usageRows(): Array<{ label: string; usage: TokenSplit }> {
    return this.flatten().flatMap((row) => (row.node.usage ? [{ label: row.node.label, usage: row.node.usage }] : []));
  }

  /** Depth-first rows for rendering, with last-sibling flags per ancestor level for branch glyphs. */
  flatten(): TreeRow[] {
    const rows: TreeRow[] = [];
    const walk = (nodes: StepNode[], depth: number, ancestors: boolean[]): void => {
      nodes.forEach((node, i) => {
        const isLast = [...ancestors, i === nodes.length - 1];
        rows.push({ node, depth, isLast });
        walk(node.children, depth + 1, isLast);
      });
    };
    walk(this.roots, 0, []);
    return rows;
  }
}
