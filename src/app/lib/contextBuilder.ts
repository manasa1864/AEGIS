// Fetch all files relevant to the detected error categories so the AI has
// full context — not just the workflow YAML — when generating fixes.
// Returns workflowFiles + additionalFiles merged into allFiles.

import { fetchRepoFile as fetchGhFile } from './github';
import { fetchRepoFile as fetchGlFile } from './gitlab';
import type { ErrorDiagnosis } from './diagnostics';
import { sanitizeForAI } from './sanitize';

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

async function fetchMany(
  paths: string[],
  fetcher: (p: string) => Promise<FileContent | null>,
): Promise<FileContent[]> {
  const results = await Promise.all(paths.map(p => fetcher(p).catch(() => null)));
  return results.filter((r): r is FileContent => r !== null);
}

export async function buildGithubContext(
  pat: string, owner: string, repo: string, branch: string,
  workflowFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
): Promise<RepoContext> {
  const diagArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

  // Union: universal set + every matched category's specific relevant files
  const allRelevant = [
    ...UNIVERSAL_FILES,
    ...diagArray.flatMap(d => d.relevantFiles),
  ];

  const existingPaths = new Set(workflowFiles.map(w => w.path));
  const candidates = [...new Set(allRelevant)].filter(
    p => !existingPaths.has(p) && ![...existingPaths].some(e => e.endsWith(`/${p}`)),
  );

  const additionalFiles = (await fetchMany(
    candidates,
    p => fetchGhFile(pat, owner, repo, p, branch),
  ))
    .slice(0, MAX_ADDITIONAL_FILES)
    .map(f => ({ ...f, content: sanitizeForAI(f.content) }));

  const sanitizedWorkflow = workflowFiles.map(f => ({ ...f, content: sanitizeForAI(f.content) }));
  return { workflowFiles: sanitizedWorkflow, additionalFiles, allFiles: [...sanitizedWorkflow, ...additionalFiles] };
}

export async function buildGitlabContext(
  pat: string, owner: string, repo: string, branch: string,
  ciFiles: FileContent[], diagnoses: ErrorDiagnosis | ErrorDiagnosis[],
): Promise<RepoContext> {
  const diagArray = Array.isArray(diagnoses) ? diagnoses : [diagnoses];

  const allRelevant = [
    ...UNIVERSAL_FILES,
    ...diagArray.flatMap(d => d.relevantFiles),
  ];

  const existingPaths = new Set(ciFiles.map(c => c.path));
  const candidates = [...new Set(allRelevant)].filter(
    p => !existingPaths.has(p),
  );

  const additionalFiles = (await fetchMany(
    candidates,
    p => fetchGlFile(pat, owner, repo, p, branch),
  ))
    .slice(0, MAX_ADDITIONAL_FILES)
    .map(f => ({ ...f, content: sanitizeForAI(f.content) }));

  const sanitizedCI = ciFiles.map(f => ({ ...f, content: sanitizeForAI(f.content) }));
  return { workflowFiles: sanitizedCI, additionalFiles, allFiles: [...sanitizedCI, ...additionalFiles] };
}
