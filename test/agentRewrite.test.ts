import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentCliArgs, buildRewritePrompt, runAgentRewrite, type ProcessRunner, type RewriteAsk } from '../src/review/agentRewrite.js';
import type { ReviewFinding } from '../src/review/types.js';

const FINDING: ReviewFinding = { file: 'src/app.ts', line: 12, severity: 'MAJOR', comment: '### Bad\n\nfix it', code: 'const x = 1;' };

function ask(overrides: Partial<RewriteAsk> = {}): RewriteAsk {
  return { finding: FINDING, currentBody: '### Bad\n\nfix it', context: '', agent: 'claude', ...overrides };
}

test('the prompt names the location, the current comment, and where to save the answer', () => {
  const prompt = buildRewritePrompt(ask(), '/tmp/out.md');
  assert.match(prompt, /src\/app\.ts:12 \(MAJOR\)/);
  assert.match(prompt, /const x = 1;/);
  assert.match(prompt, /### Bad\n\nfix it/);
  assert.match(prompt, /\/tmp\/out\.md/);
});

test('the reviewer\'s extra context is included only when non-empty', () => {
  const withContext = buildRewritePrompt(ask({ context: 'consider another point of view' }), '/tmp/out.md');
  assert.match(withContext, /consider another point of view/);
  const withoutContext = buildRewritePrompt(ask({ context: '   ' }), '/tmp/out.md');
  assert.doesNotMatch(withoutContext, /Additional context/);
});

test('agentCliArgs starts each CLI interactive with the prompt as its opening message', () => {
  assert.deepEqual(agentCliArgs('claude', 'hello'), ['hello']);
  assert.deepEqual(agentCliArgs('pi', 'hello'), ['hello']);
  assert.deepEqual(agentCliArgs('copilot', 'hello'), ['-i', 'hello']);
});

test('runAgentRewrite reads back whatever the agent saved to its temp file, then cleans it up', async () => {
  let capturedOutFile = '';
  const runner: ProcessRunner = {
    async run(command, args, cwd) {
      assert.equal(command, 'claude');
      assert.equal(cwd, '/repo');
      const outFile = args[0].match(/overwriting anything already there: (\S+)/)?.[1];
      assert.ok(outFile, 'the prompt must name the out file');
      capturedOutFile = outFile!;
      writeFileSync(outFile!, '### Rewritten\n\nbetter now\n');
    },
  };
  const result = await runAgentRewrite(ask(), '/repo', runner);
  assert.equal(result, '### Rewritten\n\nbetter now');
  assert.throws(() => readFileSync(capturedOutFile), 'the temp file must be cleaned up after being read');
});

test('runAgentRewrite returns undefined when the agent never saved anything', async () => {
  const runner: ProcessRunner = { async run() {} };
  const result = await runAgentRewrite(ask(), '/repo', runner);
  assert.equal(result, undefined);
});

test('runAgentRewrite still cleans up a temp file left behind by a crashing runner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-rewrite-test-'));
  let capturedOutFile = '';
  try {
    const runner: ProcessRunner = {
      async run(_command, args) {
        const outFile = args[0].match(/overwriting anything already there: (\S+)/)?.[1];
        capturedOutFile = outFile!;
        writeFileSync(outFile!, 'partial');
        throw new Error('agent crashed');
      },
    };
    await assert.rejects(() => runAgentRewrite(ask(), dir, runner), /agent crashed/);
    assert.throws(() => readFileSync(capturedOutFile), 'the temp file must be cleaned up even when the runner throws');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
