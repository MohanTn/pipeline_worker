import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDescription } from '../src/workflow/openMergeRequest.js';
import type { CapturedIntent, CheckResult } from '../src/types.js';

const INTENT: CapturedIntent = {
  intent: 'Let users sign in.',
  summary: 'Adds a login page.',
  changeType: 'feature',
  branchSlug: 'add-login-page',
  commitMessage: 'feat: add login page',
  fileChanges: [
    { file: 'src/login.ts', summary: 'Adds the login form component.' },
    { file: 'src/routes.ts', summary: 'Registers the /login route.' },
  ],
  risk: 'low',
  riskReason: 'New, isolated component with no existing callers.',
  testScenarios: ['Submit valid credentials and confirm redirect to the dashboard.'],
};

const CHECKS: CheckResult[] = [
  { name: 'build', ok: true, stdout: '', stderr: '', durationMs: 1200 },
  { name: 'lint', ok: true, stdout: '', stderr: '', durationMs: 800 },
  { name: 'test', ok: true, stdout: '', stderr: '', durationMs: 5100 },
];

test('buildDescription renders Intent, Summary, File changes, Risk, Checks, and Test Scenarios sections', () => {
  const description = buildDescription(INTENT, 'claude', CHECKS);
  assert.match(description, /\*\*Intent:\*\* Let users sign in\./);
  assert.match(description, /\*\*Summary:\*\* Adds a login page\./);
  assert.match(description, /\*\*File changes:\*\*\n- `src\/login\.ts`: Adds the login form component\.\n- `src\/routes\.ts`: Registers the \/login route\./);
  assert.match(description, /\*\*Risk:\*\* Low — New, isolated component with no existing callers\./);
  assert.match(description, /\*\*Checks:\*\*\n- ✅ build \(1\.2s\)\n- ✅ lint \(0\.8s\)\n- ✅ test \(5\.1s\)/);
  assert.match(description, /\*\*Test Scenarios:\*\*\n- Submit valid credentials and confirm redirect to the dashboard\./);
  assert.match(description, /intent captured via \*\*claude\*\*/);
});

test('buildDescription marks a failed check with ❌', () => {
  const description = buildDescription(INTENT, 'claude', [{ name: 'build', ok: false, stdout: '', stderr: '', durationMs: 500 }]);
  assert.match(description, /\*\*Checks:\*\*\n- ❌ build \(0\.5s\)/);
});

test('buildDescription renders a placeholder instead of an empty list when no checks were run locally (resume\'s branch-adoption path refreshing an existing MR/PR)', () => {
  const description = buildDescription(INTENT, 'claude', []);
  assert.match(description, /\*\*Checks:\*\*\n_Not run locally for this update — see the CI pipeline below\._/);
});
