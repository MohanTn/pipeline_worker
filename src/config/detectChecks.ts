/**
 * Toolchain detection: default build/lint/test commands for the target repo's
 * language. An empty command means "no sensible default here" and the stage is
 * skipped (see runChecks.ts). Explicit .pipeline-worker.yml values always win
 * (see loader.ts). The first marker that matches decides; mixed-language repos
 * should set the commands explicitly.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DetectedChecks {
  language: 'node' | 'dotnet' | 'go' | 'python' | 'unknown';
  build: string;
  lint: string;
  test: string;
}

const DOTNET_SOLUTION_SUFFIXES = ['.sln', '.slnx'];
const DOTNET_PROJECT_SUFFIXES = [...DOTNET_SOLUTION_SUFFIXES, '.csproj', '.fsproj', '.vbproj'];
const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'requirements.txt'];

/** Maps each stage to `npm run <script>` only for scripts the repo declares. */
function detectNode(repoRoot: string): DetectedChecks {
  let scripts: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).scripts;
    scripts = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch {
    // Corrupt/unreadable package.json: keep the npm commands so npm itself
    // reports the real problem instead of the checks being silently skipped.
    return { language: 'node', build: 'npm run build', lint: 'npm run lint', test: 'npm test' };
  }
  return {
    language: 'node',
    build: 'build' in scripts ? 'npm run build' : '',
    lint: 'lint' in scripts ? 'npm run lint' : '',
    test: 'test' in scripts ? 'npm test' : '',
  };
}

/**
 * Returns true when the repo uses CSharpier as its formatter.
 * Detected via a .csharpierignore file at the root OR a 'csharpier' entry
 * in .config/dotnet-tools.json (the standard local tools manifest).
 */
function hasCsharpier(repoRoot: string): boolean {
  if (existsSync(join(repoRoot, '.csharpierignore'))) return true;
  const toolsManifest = join(repoRoot, '.config', 'dotnet-tools.json');
  if (!existsSync(toolsManifest)) return false;
  try {
    const manifest = JSON.parse(readFileSync(toolsManifest, 'utf-8')) as { tools?: Record<string, unknown> };
    return 'csharpier' in (manifest.tools ?? {});
  } catch {
    return false;
  }
}

/**
 * Builds the DetectedChecks for a .NET repo.
 * @param repoRoot  - absolute path to the repo root
 * @param slnSubdir - relative subdirectory containing the .sln (e.g. 'src'), or undefined if at root
 */
function detectDotnet(repoRoot: string, slnSubdir?: string): DetectedChecks {
  const build = slnSubdir ? `dotnet build ${slnSubdir}` : 'dotnet build';

  const lint = hasCsharpier(repoRoot)
    ? 'dotnet tool restore && dotnet csharpier check .'
    : 'dotnet format --verify-no-changes';

  // A `run-tests` script is a common pattern for repos that wrap dotnet test
  // with coverage reporting; prefer it over the bare dotnet test command.
  const test = existsSync(join(repoRoot, 'run-tests')) ? './run-tests Unit' : 'dotnet test';

  return { language: 'dotnet', build, lint, test };
}

export function detectChecks(repoRoot: string): DetectedChecks {
  if (existsSync(join(repoRoot, 'package.json'))) return detectNode(repoRoot);

  let rootEntries: string[] = [];
  try {
    rootEntries = readdirSync(repoRoot);
  } catch {
    // Unreadable root: fall through to unknown, honoring loader.ts's never-throw contract.
  }

  // .sln/.csproj at the repo root
  if (rootEntries.some((name) => DOTNET_PROJECT_SUFFIXES.some((suffix) => name.endsWith(suffix)))) {
    return detectDotnet(repoRoot);
  }

  // .sln in a src/ subdirectory — a common layout where source lives one level down
  const srcDir = join(repoRoot, 'src');
  if (existsSync(srcDir)) {
    try {
      const srcEntries = readdirSync(srcDir);
      if (srcEntries.some((name) => DOTNET_SOLUTION_SUFFIXES.some((suffix) => name.endsWith(suffix)))) {
        return detectDotnet(repoRoot, 'src');
      }
    } catch {
      // Ignore readdir errors on the src/ subdirectory.
    }
  }

  if (existsSync(join(repoRoot, 'go.mod'))) {
    return { language: 'go', build: 'go build ./...', lint: 'go vet ./...', test: 'go test ./...' };
  }
  if (PYTHON_MARKERS.some((marker) => existsSync(join(repoRoot, marker)))) {
    // No universal python build/lint step; pytest is the de-facto test runner.
    return { language: 'python', build: '', lint: '', test: 'pytest' };
  }
  return { language: 'unknown', build: '', lint: '', test: '' };
}