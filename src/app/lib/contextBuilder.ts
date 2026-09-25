// Fetch all files relevant to the detected error categories so the AI has
// full context — not just the workflow YAML — when generating fixes.
// Returns workflowFiles + additionalFiles merged into allFiles.

import { fetchRepoFile as fetchGhFile } from './github';
import { fetchRepoFile as fetchGlFile } from './gitlab';
import type { ErrorDiagnosis } from './diagnostics';
import { logReferencedSourcePaths } from './fixers/code/source';

// File contents are returned RAW. Rule fixers edit these contents and the
// result is committed, so they must be byte-for-byte what is in the repo.
// Prompt-injection sanitising happens where contents are embedded into an AI
// prompt (gemini.ts / groq.ts / vertexai.ts), never here — sanitising here once
// committed "[FILTERED]" into workflows that merely contained `rm -rf /tmp/x`.

// Source files named in the CI logs (stack frames, compiler/linter output) —
// fetched so the code-level fixers and the AI can edit the actual failing code.
const MAX_LOG_REFERENCED_FILES = 8;

// Hard cap on extra files fetched per run — prevents token-window explosion
// for large repos that match many universal file paths.
const MAX_ADDITIONAL_FILES = 15;

type FileContent = { path: string; content: string; sha: string };

export interface RepoContext {
  workflowFiles: FileContent[];
  additionalFiles: FileContent[];
  allFiles: FileContent[];  // pass this to AI analysis
}

// Universal files fetched for EVERY healing run regardless of error category.
// Keep this list lean — every entry that doesn't exist in the target repo becomes
// a 404 request. Cover all major stacks without probing exhaustive variants.
const UNIVERSAL_FILES = [
  // JS/TS — package manager lock files tell us which manager is in use
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.nvmrc', '.node-version',
  'tsconfig.json', 'tsconfig.build.json',
  // Linting / formatting — one canonical name per tool
  '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs',
  '.prettierrc', '.prettierrc.json',
  // Test runners
  'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js',
  'playwright.config.ts', 'cypress.config.ts',
  // Build tools
  'vite.config.ts', 'vite.config.js', 'webpack.config.js',
  'babel.config.js', '.babelrc',
  // Docker / containers
  'Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml',
  // Python
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py',
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

export async function buildGithubContext(
  pat: string, owner: string, repo: string, branch: string,
  workflowFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
  logs = '',
): Promise<RepoContext> {
  const diagArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

  // Union: log-referenced source first (most specific), then the universal set
  // and every matched category's relevant files
  const allRelevant = [
    ...logReferencedSourcePaths(logs, MAX_LOG_REFERENCED_FILES),
    ...UNIVERSAL_FILES,
    ...diagArray.flatMap(d => d.relevantFiles),
  ];

  const existingPaths = new Set(workflowFiles.map(w => w.path));
  const candidates = [...new Set(allRelevant)].filter(
    p => !existingPaths.has(p) && ![...existingPaths].some(e => e.endsWith(`/${p}`)),
  );

  const additionalFiles = await fetchMany(
    candidates,
    p => fetchGhFile(pat, owner, repo, p, branch),
    MAX_ADDITIONAL_FILES + MAX_LOG_REFERENCED_FILES,
  );

  return { workflowFiles, additionalFiles, allFiles: [...workflowFiles, ...additionalFiles] };
}

export async function buildGitlabContext(
  pat: string, owner: string, repo: string, branch: string,
  ciFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
  logs = '',
): Promise<RepoContext> {
  const diagArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

  const allRelevant = [
    ...logReferencedSourcePaths(logs, MAX_LOG_REFERENCED_FILES),
    ...UNIVERSAL_FILES,
    ...diagArray.flatMap(d => d.relevantFiles),
  ];

  const existingPaths = new Set(ciFiles.map(c => c.path));
  const candidates = [...new Set(allRelevant)].filter(
    p => !existingPaths.has(p),
  );

  const additionalFiles = await fetchMany(
    candidates,
    p => fetchGlFile(pat, owner, repo, p, branch),
    MAX_ADDITIONAL_FILES + MAX_LOG_REFERENCED_FILES,
  );

  return { workflowFiles: ciFiles, additionalFiles, allFiles: [...ciFiles, ...additionalFiles] };
}
