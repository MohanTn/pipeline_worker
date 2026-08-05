import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCommitHooks } from '../src/git/prepareHooks.js';

/** Puts a fake `name` binary on PATH that appends its argv to argsFile, then runs `script`. */
function withFakeBinary(name: string, script: string): { binDir: string; argsFile: string; cleanup: () => void } {
  const topDir = mkdtempSync(join(tmpdir(), `pw-preparehooks-fake-${name}-`));
  const binDir = join(topDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const argsFile = join(topDir, 'args.txt');
  writeFileSync(join(binDir, name), `#!/bin/sh\necho "$@" >> "${argsFile}"\n${script}\n`);
  chmodSync(join(binDir, name), 0o755);
  return { binDir, argsFile, cleanup: () => rmSync(topDir, { recursive: true, force: true }) };
}

function withPath<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${binDir}:${original}`;
  return fn().finally(() => {
    process.env.PATH = original;
  });
}

/** args.txt only exists once the fake binary actually ran; a "skipped" case leaves it absent. */
function readArgs(argsFile: string): string {
  return existsSync(argsFile) ? readFileSync(argsFile, 'utf-8') : '';
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pw-preparehooks-repo-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('prepareCommitHooks runs "npm run prepare" when the worktree has a .husky dir and a prepare script', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prepare: 'husky' } }));
    const npm = withFakeBinary('npm', 'exit 0');
    try {
      await withPath(npm.binDir, () => prepareCommitHooks(dir));
      assert.match(readFileSync(npm.argsFile, 'utf-8'), /run prepare/);
    } finally {
      npm.cleanup();
    }
  }));

test('prepareCommitHooks skips npm when there is no .husky dir', () =>
  withTempDir(async (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prepare: 'husky' } }));
    const npm = withFakeBinary('npm', 'exit 0');
    try {
      await withPath(npm.binDir, () => prepareCommitHooks(dir));
      assert.doesNotMatch(readArgs(npm.argsFile), /run prepare/);
    } finally {
      npm.cleanup();
    }
  }));

test('prepareCommitHooks skips npm when package.json has no prepare script', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const npm = withFakeBinary('npm', 'exit 0');
    try {
      await withPath(npm.binDir, () => prepareCommitHooks(dir));
      assert.equal(readArgs(npm.argsFile), '');
    } finally {
      npm.cleanup();
    }
  }));

test('prepareCommitHooks runs "dotnet tool restore" when the worktree has a dotnet local-tool manifest', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: {} } }));
    const dotnet = withFakeBinary('dotnet', 'exit 0');
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.match(readFileSync(dotnet.argsFile, 'utf-8'), /tool restore/);
    } finally {
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks skips dotnet when there is no local-tool manifest', () =>
  withTempDir(async (dir) => {
    const dotnet = withFakeBinary('dotnet', 'exit 0');
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.equal(readArgs(dotnet.argsFile), '');
    } finally {
      dotnet.cleanup();
    }
  }));

/** Fake `dotnet` that writes the husky bootstrap on `dotnet husky install`, like the real Husky.Net CLI does. */
const DOTNET_HUSKY_INSTALL_SCRIPT = 'if [ "$1" = "husky" ]; then mkdir -p .husky/_ && echo "#!/bin/sh" > .husky/_/husky.sh; fi\nexit 0';

function captureConsoleError(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.join(' '));
  };
  return { messages, restore: () => (console.error = original) };
}

test('prepareCommitHooks runs "dotnet husky install" when the manifest declares Husky.Net, regenerating .husky/_/husky.sh', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.husky', 'pre-commit'), '#!/bin/sh\n. .husky/_/husky.sh\n');
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: { version: '0.7.2' } } }));
    const dotnet = withFakeBinary('dotnet', DOTNET_HUSKY_INSTALL_SCRIPT);
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.match(readFileSync(dotnet.argsFile, 'utf-8'), /tool restore/);
      assert.match(readFileSync(dotnet.argsFile, 'utf-8'), /husky install/);
      assert.ok(existsSync(join(dir, '.husky', '_', 'husky.sh')));
    } finally {
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks skips "dotnet husky install" when the manifest declares no husky tool', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { csharpier: {} } }));
    const dotnet = withFakeBinary('dotnet', 'exit 0');
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.doesNotMatch(readArgs(dotnet.argsFile), /husky install/);
    } finally {
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks skips "dotnet husky install" when there is no .husky dir', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: {} } }));
    const dotnet = withFakeBinary('dotnet', DOTNET_HUSKY_INSTALL_SCRIPT);
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.doesNotMatch(readArgs(dotnet.argsFile), /husky install/);
    } finally {
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks warns when "dotnet husky install" leaves .husky/_/husky.sh missing', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: {} } }));
    const dotnet = withFakeBinary('dotnet', 'exit 0');
    const logs = captureConsoleError();
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.ok(logs.messages.some((message) => message.includes('.husky/_/husky.sh missing')));
    } finally {
      logs.restore();
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks skips "dotnet husky install" when "dotnet tool restore" fails', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: {} } }));
    const dotnet = withFakeBinary('dotnet', 'exit 1');
    const logs = captureConsoleError();
    try {
      await withPath(dotnet.binDir, () => prepareCommitHooks(dir));
      assert.doesNotMatch(readArgs(dotnet.argsFile), /husky install/);
    } finally {
      logs.restore();
      dotnet.cleanup();
    }
  }));

test('prepareCommitHooks never throws, even when both commands fail', () =>
  withTempDir(async (dir) => {
    mkdirSync(join(dir, '.husky'));
    mkdirSync(join(dir, '.config'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prepare: 'husky' } }));
    writeFileSync(join(dir, '.config', 'dotnet-tools.json'), JSON.stringify({ tools: { husky: {} } }));
    const npm = withFakeBinary('npm', 'exit 1');
    const dotnet = withFakeBinary('dotnet', 'exit 1');
    try {
      await withPath(`${npm.binDir}:${dotnet.binDir}`, () => prepareCommitHooks(dir));
    } finally {
      npm.cleanup();
      dotnet.cleanup();
    }
  }));
