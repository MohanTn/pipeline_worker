import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectChecks } from '../src/config/detectChecks.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-detect-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('detects node and only maps declared npm scripts', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint .' } }));
    const detected = detectChecks(dir);
    assert.equal(detected.language, 'node');
    assert.equal(detected.build, 'npm run build');
    assert.equal(detected.lint, 'npm run lint');
    assert.equal(detected.test, ''); // no test script declared
  });
});

test('corrupt package.json keeps the npm commands so npm reports the error', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), '{not json');
    const detected = detectChecks(dir);
    assert.equal(detected.language, 'node');
    assert.equal(detected.build, 'npm run build');
    assert.equal(detected.test, 'npm test');
  });
});

test('detects dotnet from a solution or project file at the root', () => {
  for (const marker of ['App.sln', 'App.csproj', 'App.fsproj']) {
    withTempDir((dir) => {
      writeFileSync(join(dir, marker), '');
      const detected = detectChecks(dir);
      assert.equal(detected.language, 'dotnet');
      assert.equal(detected.build, 'dotnet build');
      assert.equal(detected.lint, 'dotnet format --verify-no-changes');
      assert.equal(detected.test, 'dotnet test');
    });
  }
});

test('detects go from go.mod', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/m\n');
    const detected = detectChecks(dir);
    assert.equal(detected.language, 'go');
    assert.equal(detected.build, 'go build ./...');
    assert.equal(detected.lint, 'go vet ./...');
    assert.equal(detected.test, 'go test ./...');
  });
});

test('detects python from pyproject.toml with pytest only', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), '');
    const detected = detectChecks(dir);
    assert.equal(detected.language, 'python');
    assert.equal(detected.build, '');
    assert.equal(detected.lint, '');
    assert.equal(detected.test, 'pytest');
  });
});

test('package.json wins over other markers in a mixed repo', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    writeFileSync(join(dir, 'App.csproj'), '');
    assert.equal(detectChecks(dir).language, 'node');
  });
});

test('returns unknown with empty commands when no marker matches', () => {
  withTempDir((dir) => {
    const detected = detectChecks(dir);
    assert.equal(detected.language, 'unknown');
    assert.equal(detected.build, '');
    assert.equal(detected.lint, '');
    assert.equal(detected.test, '');
  });
});
