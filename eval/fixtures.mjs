/**
 * Scenario fixtures for the intent-capture promptfoo eval (see
 * captureIntentProvider.mjs). Each scenario is a real temp git repo with one
 * committed base state and an uncommitted change on top — the exact shape
 * captureIntent() runs against in production (mirrors
 * test/captureIntent.test.ts's makeWorktreeWithChange, generalized to a
 * table of scenarios instead of one hardcoded change).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const execFileAsync = promisify(execFile);

const SCENARIOS = {
  // An isolated new file with no existing callers — should read as a
  // low-risk feature.
  'feature-login-page': {
    base: {
      'src/app.ts': "export function main() {\n  console.log('app started');\n}\n",
    },
    changed: {},
    added: {
      'src/login.ts':
        'export function renderLoginForm() {\n' +
        '  return \'<form><input name="email"/><input name="password" type="password"/></form>\';\n' +
        '}\n',
    },
  },

  // A one-line boundary correction — should read as a bugfix, not a feature.
  'bugfix-off-by-one': {
    base: {
      'src/pagination.ts': 'export function lastPage(items, pageSize) {\n  return Math.floor(items.length / pageSize);\n}\n',
    },
    changed: {
      'src/pagination.ts': 'export function lastPage(items, pageSize) {\n  return Math.ceil(items.length / pageSize) - 1;\n}\n',
    },
    added: {},
  },

  // A dependency version bump with no source change — should read as a
  // low-risk chore.
  'chore-dependency-bump': {
    base: {
      'package.json': '{\n  "devDependencies": {\n    "eslint": "8.56.0"\n  }\n}\n',
    },
    changed: {
      'package.json': '{\n  "devDependencies": {\n    "eslint": "8.57.0"\n  }\n}\n',
    },
    added: {},
  },

  // Removes a token-expiry check from a security-sensitive function. The
  // diff itself carries the risk signal (no need for the model to know the
  // file is "shared") — should be classified high risk.
  'security-expiry-check-removed': {
    base: {
      'src/auth.ts':
        'export function verifyToken(decoded) {\n' +
        '  // SECURITY: must reject expired tokens\n' +
        "  if (decoded.exp < Date.now() / 1000) {\n    throw new Error('Token expired');\n  }\n" +
        '  return decoded;\n' +
        '}\n',
    },
    changed: {
      'src/auth.ts': 'export function verifyToken(decoded) {\n  return decoded;\n}\n',
    },
    added: {},
  },
};

export function scenarioNames() {
  return Object.keys(SCENARIOS);
}

function writeScenarioFile(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** Builds a temp worktree for `scenarioName`; caller must call the returned cleanup(). */
export async function buildWorktree(scenarioName) {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`unknown eval scenario "${scenarioName}" — known scenarios: ${scenarioNames().join(', ')}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-eval-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'eval@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Eval'], { cwd: dir });

  for (const [file, content] of Object.entries(scenario.base)) {
    writeScenarioFile(dir, file, content);
  }
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  // Left uncommitted, same as a real pipeline-worker run's worktree — new
  // files stay untracked so captureIntent's filesMissingFromDiff/Read path
  // is exercised the same way it is in production.
  const files = [];
  for (const [file, content] of Object.entries(scenario.changed)) {
    writeScenarioFile(dir, file, content);
    files.push(file);
  }
  for (const [file, content] of Object.entries(scenario.added)) {
    writeScenarioFile(dir, file, content);
    files.push(file);
  }

  return { dir, files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
