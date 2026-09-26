// Fetch all files relevant to the detected error categories so the rules and
// the AI have full context — not just the workflow YAML — when generating fixes.
// Returns workflowFiles + additionalFiles merged into allFiles.
//
// The repo tree is listed once, so every candidate is resolved to a path that
// exists: tools print paths relative to the job's working directory
// ("src/utils/dates.ts(2,1)" for services/api/src/utils/dates.ts), manifests
// live next to each job (services/worker/requirements.txt), and nothing is
// requested that would 404. Without a tree listing it falls back to probing
// the root and each job directory.

import { fetchRepoFile as fetchGhFile, listRepoPaths as listGhPaths } from './github';
import { fetchRepoFile as fetchGlFile, listRepoPaths as listGlPaths } from './gitlab';
import type { ErrorDiagnosis } from './diagnostics';
import { logReferencedSourcePaths, missingExportModules, missingLocalModules, normalizeRepoPath } from './fixers/code/source';
import { jobDirectories, joinPath, dirOf } from './fixers/workflowJobs';

// File contents are returned RAW. Rule fixers edit these contents and the
// result is committed, so they must be byte-for-byte what is in the repo.
// Prompt-injection sanitising happens where contents are embedded into an AI
// prompt (gemini.ts / groq.ts / vertexai.ts), never here — sanitising here once
// committed "[FILTERED]" into workflows that merely contained `rm -rf /tmp/x`.

// Source files named in the CI logs (stack frames, compiler/linter output) —
// fetched so the code-level fixers and the AI can edit the actual failing code.
const MAX_LOG_REFERENCED_FILES = 16;

// Hard cap on extra files fetched per run — prevents token-window explosion
// for large repos that match many universal file paths.
const MAX_ADDITIONAL_FILES = 30;

type FileContent = { path: string; content: string; sha: string };

export interface RepoContext {
  workflowFiles: FileContent[];
  additionalFiles: FileContent[];
  allFiles: FileContent[];  // pass this to AI analysis
}

// Manifest / config files fetched for EVERY healing run, at the repo root and
// in every directory a CI job runs in. Keep this list lean.
const UNIVERSAL_FILES = [
  // JS/TS — package manager lock files tell us which manager is in use
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.nvmrc', '.node-version', '.npmrc',
  'tsconfig.json', 'tsconfig.build.json',
  // Linting / formatting — one canonical name per tool
  '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs',
  '.prettierrc', '.prettierrc.json',
  // Test runners
  'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js',
  'playwright.config.ts', 'cypress.config.ts',
  // Build tools
  'vite.config.ts', 'vite.config.js', 'webpack.config.js',
  'babel.config.js', '.babelrc',
  // Docker / containers
  'Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  // Python
  'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg',
  // Go
  'go.mod',
  // Rust
  'Cargo.toml',
  // .NET
  'global.json',
  // Ruby
  'Gemfile',
  // Infra
  'main.tf',
  // Env / secrets docs
  '.env.example',
  // CI config extras
  'codecov.yml', '.github/CODEOWNERS',
];

const DOCKERFILE_NAME = /(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|[\w-]+\.Dockerfile)$/;

// Fetch with bounded concurrency — firing all ~60 candidate paths at once can
// trip GitHub's secondary rate limits. Stops early once enough files are found.
const FETCH_CONCURRENCY = 10;

async function fetchMany(
  paths: string[],
  fetcher: (p: string) => Promise<FileContent | null>,
  maxResults = MAX_ADDITIONAL_FILES,
): Promise<FileContent[]> {
  const found: FileContent[] = [];
  for (let i = 0; i < paths.length && found.length < maxResults; i += FETCH_CONCURRENCY) {
    const batch = paths.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(p => fetcher(p).catch(() => null)));
    for (const r of results) if (r !== null) found.push(r);
  }
  return found.slice(0, maxResults);
}

/**
 * Ordered, de-duplicated list of repo paths worth fetching for this failure.
 * With `tree` every entry is known to exist; without it, entries are guesses
 * (root + job directories) that may 404.
 */
export function contextCandidates(
  tree: string[] | null, workflowFiles: Array<{ path: string; content: string }>,
  diagnoses: ErrorDiagnosis[], logs: string,
): string[] {
  const treeSet = tree ? new Set(tree) : null;
  const inTree = (p: string) => (treeSet ? treeSet.has(p) : true);
  const jobDirs = jobDirectories(workflowFiles);
  const out: string[] = [];
  const add = (p: string) => { if (p && !out.includes(p) && inTree(p)) out.push(p); };

  // 1. Files the logs point at — resolved to where they really are
  const resolved: string[] = [];
  for (const ref of logReferencedSourcePaths(logs, MAX_LOG_REFERENCED_FILES)) {
    if (!tree) { add(ref); jobDirs.forEach(d => add(joinPath(d, ref))); continue; }
    if (treeSet!.has(ref)) { resolved.push(ref); continue; }
    const bySuffix = tree.filter(p => p.endsWith(`/${ref}`));
    const preferred = bySuffix.filter(p => jobDirs.some(d => p.startsWith(`${d}/`)));
    resolved.push(...(preferred.length ? preferred : bySuffix).slice(0, 2));
  }
  resolved.forEach(add);

  // 2. Modules a compiler says lack an export — the importing file's relative import target
  for (const { importer, spec } of missingExportModules(logs)) {
    const from = resolved.find(p => p === importer || p.endsWith(`/${importer}`)) ?? importer;
    const base = joinPath(dirOf(from), spec).split('/').reduce<string[]>((acc, seg) => (seg === '..' ? acc.slice(0, -1) : seg === '.' ? acc : [...acc, seg]), []).join('/');
    for (const ext of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) add(base + ext);
  }

  // 3. Local Python modules that failed to import — wherever a file of that name lives now
  if (tree) {
    for (const mod of missingLocalModules(logs)) {
      const parts = mod.split('.');
      const leaf = parts[parts.length - 1];
      tree.filter(p => (p.endsWith(`/${leaf}.py`) || p.endsWith(`/${leaf}/__init__.py`)) && p.split('/').includes(parts[0]))
        .slice(0, 3).forEach(add);
    }
  }

  // 4. Manifests at the root, in every job directory, and next to each referenced file
  const manifestDirs = ['', ...jobDirs];
  for (const r of resolved) for (let d = dirOf(r); d; d = dirOf(d)) if (!manifestDirs.includes(d)) manifestDirs.push(d);
  for (const dir of manifestDirs) for (const name of UNIVERSAL_FILES) add(joinPath(dir, name));

  // 5. Every matched category's relevant files, at the root and in job directories
  for (const d of diagnoses) for (const f of d.relevantFiles) {
    if (f.endsWith('/')) continue;
    add(f);
    jobDirs.forEach(dir => add(joinPath(dir, f)));
  }

  // 6. Files CI commands name explicitly: Dockerfiles, compose files, k8s manifests (kubectl apply -f)
  if (tree) {
    if (/dockerfile/i.test(logs)) tree.filter(p => DOCKERFILE_NAME.test(p)).slice(0, 5).forEach(add);
    for (const wf of workflowFiles) {
      for (const m of wf.content.matchAll(/(?:kubectl\s+apply|docker\s+compose|docker-compose)\b[^\n]*?\s-f\s+([\w./-]+)/g)) {
        const target = normalizeRepoPath(m[1]).replace(/\/+$/, '');
        if (treeSet!.has(target)) add(target);
        else tree.filter(p => p.startsWith(`${target}/`) && /\.ya?ml$/.test(p)).slice(0, 8).forEach(add);
      }
    }
  }
  return out;
}

async function buildContext(
  listPaths: () => Promise<string[] | null>,
  fetchFile: (p: string) => Promise<FileContent | null>,
  workflowFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[], logs: string,
): Promise<RepoContext> {
  const diagArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses];
  const tree = await listPaths().catch(() => null);
  const existing = new Set(workflowFiles.map(w => w.path));
  const candidates = contextCandidates(tree, workflowFiles, diagArray, logs).filter(p => !existing.has(p));
  const additionalFiles = await fetchMany(candidates, fetchFile, MAX_ADDITIONAL_FILES + MAX_LOG_REFERENCED_FILES);
  return { workflowFiles, additionalFiles, allFiles: [...workflowFiles, ...additionalFiles] };
}

export async function buildGithubContext(
  pat: string, owner: string, repo: string, branch: string,
  workflowFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
  logs = '',
): Promise<RepoContext> {
  return buildContext(
    () => listGhPaths(pat, owner, repo, branch),
    p => fetchGhFile(pat, owner, repo, p, branch),
    workflowFiles, diagnoses, logs,
  );
}

export async function buildGitlabContext(
  pat: string, owner: string, repo: string, branch: string,
  ciFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
  logs = '',
): Promise<RepoContext> {
  return buildContext(
    () => listGlPaths(pat, owner, repo, branch),
    p => fetchGlFile(pat, owner, repo, p, branch),
    ciFiles, diagnoses, logs,
  );
}
