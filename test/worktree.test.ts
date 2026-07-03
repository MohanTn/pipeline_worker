import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDiff, resetRepo } from '../src/git/diff.js';
import {
  createWorktree,
  syncWithOrigin,
  applyDiffToWorktree,
  removeWorktree,
  isWorktreeOnBranch,
  checkoutExistingBranch,
} from '../src/git/worktree.js';

const execFileAsync = promisify(execFile);
const FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-repo');
const DOTNET_FIXTURE = join(import.meta.dirname, 'fixtures', 'sample-dotnet-repo');

async function makeSampleRepo(fixture: string = FIXTURE): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-worker-repo-'));
  cpSync(fixture, dir, { recursive: true });
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

test('createWorktree + applyDiffToWorktree carries a tracked-file change and an untracked file', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '1.0.1'));
    writeFileSync(join(repoRoot, 'new-file.txt'), 'hello from pipeline-worker\n');

    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /1\.0\.1/);
    assert.deepEqual(untrackedFiles, ['new-file.txt']);

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-test');
    try {
      await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      const worktreePkg = readFileSync(join(worktreePath, 'package.json'), 'utf-8');
      assert.match(worktreePkg, /1\.0\.1/);
      assert.equal(readFileSync(join(worktreePath, 'new-file.txt'), 'utf-8'), 'hello from pipeline-worker\n');
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }

    assert.equal(existsSync(worktreePath), false);
    const { stdout: worktreeList } = await execFileAsync('git', ['worktree', 'list'], { cwd: repoRoot });
    assert.doesNotMatch(worktreeList, /tmp-test/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('createWorktree + applyDiffToWorktree works the same for a non-Node (.NET) repo', async () => {
  const repoRoot = await makeSampleRepo(DOTNET_FIXTURE);
  try {
    writeFileSync(join(repoRoot, 'Program.cs'), readFileSync(join(repoRoot, 'Program.cs'), 'utf-8').replace('hello', 'hello world'));
    writeFileSync(join(repoRoot, 'NewFile.cs'), '// new file\n');

    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /hello world/);
    assert.deepEqual(untrackedFiles, ['NewFile.cs']);

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-dotnet-test');
    try {
      await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      assert.match(readFileSync(join(worktreePath, 'Program.cs'), 'utf-8'), /hello world/);
      assert.equal(readFileSync(join(worktreePath, 'NewFile.cs'), 'utf-8'), '// new file\n');
      // No node_modules in a .NET repo: applyDiffToWorktree's symlink step must be a no-op, not a crash.
      assert.equal(existsSync(join(worktreePath, 'node_modules')), false);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }

    assert.equal(existsSync(worktreePath), false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('createWorktree + applyDiffToWorktree carries a modified binary file', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    const iconPath = join(repoRoot, 'icon.bin');
    writeFileSync(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    await execFileAsync('git', ['add', 'icon.bin'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'add binary icon'], { cwd: repoRoot });

    // Modify the tracked binary file so captureDiff must represent the change
    // as a binary patch, not a "Binary files ... differ" stub.
    writeFileSync(iconPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xee, 0xdd, 0xcc]));

    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /GIT binary patch/);

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-binary-test');
    try {
      await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      assert.deepEqual(
        readFileSync(join(worktreePath, 'icon.bin')),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xee, 0xdd, 0xcc]),
      );
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyDiffToWorktree restores the node_modules symlink after replaying a diff that untracks a previously-committed node_modules', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    // Simulate a repo that once accidentally committed node_modules as a
    // symlink pointing at its own absolute path (e.g. from a broken install
    // script) — the same target linkNodeModules itself writes, so replaying
    // the fix diff below looks like a no-op change to git and applies clean.
    symlinkSync(join(repoRoot, 'node_modules'), join(repoRoot, 'node_modules'));
    await execFileAsync('git', ['add', 'node_modules'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'oops: commit node_modules'], { cwd: repoRoot });

    // Now simulate fixing that mistake: untrack the symlink and install real
    // dependencies (gitignored) in its place — the PR under test.
    await execFileAsync('git', ['rm', '--cached', '-q', 'node_modules'], { cwd: repoRoot });
    rmSync(join(repoRoot, 'node_modules'));
    mkdirSync(join(repoRoot, 'node_modules'));
    writeFileSync(join(repoRoot, 'node_modules', 'marker.txt'), 'dep\n');
    writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n');
    await execFileAsync('git', ['add', '.gitignore'], { cwd: repoRoot });

    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /deleted file mode 120000/);
    assert.deepEqual(untrackedFiles, []); // node_modules is gitignored, so it's not "untracked"

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-nm-test');
    try {
      // HEAD still has the symlink tracked (the fix above is uncommitted), so
      // git worktree add checks it out as-is; applyDiffToWorktree both
      // replays the deletion and, once done, symlinks node_modules to
      // repoRoot's real dependencies for the checks that run afterward.
      await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      assert.equal(readFileSync(join(worktreePath, 'node_modules', 'marker.txt'), 'utf-8'), 'dep\n');
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyDiffToWorktree falls back to a 3-way merge with conflict markers when the base has moved, instead of failing outright', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    // Capture a diff against the current HEAD's package.json (version "1.0.0" -> "1.0.1").
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '1.0.1'));
    const { diffText, untrackedFiles } = await captureDiff(repoRoot);
    assert.match(diffText, /1\.0\.1/);

    // Discard that uncommitted change, then move repoRoot's HEAD forward with
    // a *different* edit to the same line — simulating origin having moved
    // past the diff's base (exactly what syncWithOrigin's rebase does).
    await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '2.0.0'));
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'bump to 2.0.0'], { cwd: repoRoot });

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-conflict-test');
    try {
      const result = await applyDiffToWorktree(worktreePath, diffText, untrackedFiles, repoRoot);

      assert.equal(result.conflicted, true);
      assert.deepEqual(result.conflictedFiles, ['package.json']);
      assert.match(readFileSync(join(worktreePath, 'package.json'), 'utf-8'), /<{7}/);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('syncWithOrigin rebases the worktree onto a moved-ahead origin/main, preserving a local-only commit', async () => {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const repoRoot = await makeSampleRepo();
  const otherClone = mkdtempSync(join(tmpdir(), 'pipeline-worker-other-'));
  try {
    await execFileAsync('git', ['init', '-q', '--bare', originDir]);
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoRoot });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repoRoot });

    // Someone else pushes a new commit to origin/main that repoRoot hasn't fetched yet.
    // The bare origin has no HEAD ref pointing at a branch, so clone can't
    // check one out automatically — check out main explicitly, or this
    // would silently commit to a disconnected local "master" instead.
    await execFileAsync('git', ['clone', '-q', originDir, otherClone]);
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: otherClone });
    await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: otherClone });
    writeFileSync(join(otherClone, 'upstream-change.txt'), 'from origin\n');
    await execFileAsync('git', ['add', '-A'], { cwd: otherClone });
    await execFileAsync('git', ['commit', '-q', '-m', 'upstream change'], { cwd: otherClone });
    await execFileAsync('git', ['push', '-q'], { cwd: otherClone });

    // repoRoot gets its own local-only commit, still unaware of the upstream change above.
    writeFileSync(join(repoRoot, 'local-only.txt'), 'local work\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'local only commit'], { cwd: repoRoot });

    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-sync-test');
    try {
      await syncWithOrigin(worktreePath, 'main');

      // Both the upstream commit and the local-only commit must survive a
      // rebase (a `reset --hard` to origin would have silently dropped the
      // local-only commit instead of replaying it on top).
      assert.equal(existsSync(join(worktreePath, 'upstream-change.txt')), true);
      assert.equal(existsSync(join(worktreePath, 'local-only.txt')), true);

      const { stdout: log } = await execFileAsync('git', ['log', '--oneline', '--reverse'], { cwd: worktreePath });
      const lines = log.trim().split('\n');
      assert.equal(lines.length, 3);
      assert.match(lines[1], /upstream change/);
      assert.match(lines[2], /local only commit/);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(otherClone, { recursive: true, force: true });
  }
});

test('resetRepo discards a tracked edit and deletes the given untracked files, regardless of the checked-out branch name', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    await execFileAsync('git', ['checkout', '-q', '-b', 'some-other-branch'], { cwd: repoRoot });

    writeFileSync(join(repoRoot, 'package.json'), readFileSync(join(repoRoot, 'package.json'), 'utf-8').replace('1.0.0', '1.0.1'));
    writeFileSync(join(repoRoot, 'new-file.txt'), 'hello from pipeline-worker\n');
    const { untrackedFiles } = await captureDiff(repoRoot);
    assert.deepEqual(untrackedFiles, ['new-file.txt']);

    await resetRepo(repoRoot, untrackedFiles);

    assert.match(readFileSync(join(repoRoot, 'package.json'), 'utf-8'), /1\.0\.0/);
    assert.equal(existsSync(join(repoRoot, 'new-file.txt')), false);
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot });
    assert.equal(status.trim(), '');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('resetRepo leaves untracked files outside the captured list alone', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    writeFileSync(join(repoRoot, 'captured.txt'), 'part of the diff\n');
    writeFileSync(join(repoRoot, 'unrelated-scratch.txt'), 'not part of the diff\n');

    await resetRepo(repoRoot, ['captured.txt']);

    assert.equal(existsSync(join(repoRoot, 'captured.txt')), false);
    assert.equal(existsSync(join(repoRoot, 'unrelated-scratch.txt')), true);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('isWorktreeOnBranch is true only when the path exists and HEAD matches the given branch', async () => {
  const repoRoot = await makeSampleRepo();
  try {
    const worktreePath = await createWorktree(repoRoot, 'pipeline-worker/tmp-branch-check');
    try {
      assert.equal(await isWorktreeOnBranch(worktreePath, 'pipeline-worker/tmp-branch-check'), true);
      assert.equal(await isWorktreeOnBranch(worktreePath, 'some-other-branch'), false);
      assert.equal(await isWorktreeOnBranch(join(repoRoot, 'does-not-exist'), 'pipeline-worker/tmp-branch-check'), false);
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('checkoutExistingBranch checks out a branch already pushed to origin, resetting a diverged local ref to match it', async () => {
  const originDir = mkdtempSync(join(tmpdir(), 'pipeline-worker-origin-'));
  const repoRoot = await makeSampleRepo();
  try {
    await execFileAsync('git', ['init', '-q', '--bare', originDir]);
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoRoot });
    await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoRoot });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repoRoot });

    // Push a feature branch to origin — this simulates the branch a crashed
    // `pipeline-worker run` already opened an MR for.
    await execFileAsync('git', ['checkout', '-q', '-b', 'feature/resume-test'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'feature.txt'), 'pushed to origin\n');
    await execFileAsync('git', ['add', '-A'], { cwd: repoRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'feature work'], { cwd: repoRoot });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'feature/resume-test'], { cwd: repoRoot });

    // Diverge the local branch ref from origin, simulating a stale/local-only
    // commit that must NOT leak into the resumed worktree — resume must
    // reflect what's actually on the forge (what CI ran against), not
    // whatever repoRoot's local branch happens to point at. Switch back to
    // main afterward: `git worktree add -B` refuses a branch that's checked
    // out elsewhere, and repoRoot itself counts as a worktree.
    writeFileSync(join(repoRoot, 'feature.txt'), 'diverged local-only change\n');
    await execFileAsync('git', ['commit', '-q', '-am', 'local-only divergence'], { cwd: repoRoot });
    await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });

    const worktreePath = await checkoutExistingBranch(repoRoot, 'feature/resume-test');
    try {
      assert.equal(await isWorktreeOnBranch(worktreePath, 'feature/resume-test'), true);
      assert.equal(readFileSync(join(worktreePath, 'feature.txt'), 'utf-8'), 'pushed to origin\n');
    } finally {
      await removeWorktree(repoRoot, worktreePath);
    }
  } finally {
    rmSync(originDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
