import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDescription } from '../src/workflow/openMergeRequest.js';
import type { CapturedIntent } from '../src/types.js';

const INTENT: CapturedIntent = {
  intent: 'Let users sign in.',
  summary: 'Adds a login page.',
  branchName: 'pipeline-worker/add-login-page',
  commitMessage: 'feat: add login page',
  fileChanges: [
    { file: 'src/login.ts', summary: 'Adds the login form component.' },
    { file: 'src/routes.ts', summary: 'Registers the /login route.' },
  ],
  risk: 'low',
  riskReason: 'New, isolated component with no existing callers.',
  testScenarios: ['Submit valid credentials and confirm redirect to the dashboard.'],
};

test('buildDescription renders Intent, Summary, File changes, Risk, and Test Scenarios sections', () => {
  const description = buildDescription(INTENT, 'claude');
  assert.match(description, /\*\*Intent:\*\* Let users sign in\./);
  assert.match(description, /\*\*Summary:\*\* Adds a login page\./);
  assert.match(description, /\*\*File changes:\*\*\n- `src\/login\.ts`: Adds the login form component\.\n- `src\/routes\.ts`: Registers the \/login route\./);
  assert.match(description, /\*\*Risk:\*\* Low — New, isolated component with no existing callers\./);
  assert.match(description, /\*\*Test Scenarios:\*\*\n- Submit valid credentials and confirm redirect to the dashboard\./);
  assert.match(description, /intent captured via \*\*claude\*\*/);
});
