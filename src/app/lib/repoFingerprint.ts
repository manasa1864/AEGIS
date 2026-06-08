// Analyzes the set of fetched context files to detect the repository's tech stack.
// The fingerprint is injected into the AI prompt so it can generate stack-appropriate fixes.

export interface RepoFingerprint {
  frameworks: string[];
  languages: string[];
  tooling: string[];
  isMonorepo: boolean;
  summary: string;
}

type FileMap = Array<{ path: string; content: string }>;

function hasFile(files: FileMap, name: string): boolean {
  const lower = name.toLowerCase();
  return files.some(f => {
    const fp = f.path.toLowerCase();
    return fp === lower || fp.endsWith(`/${lower}`);
  });
}

function fileContent(files: FileMap, name: string): string {
  const lower = name.toLowerCase();
  const f = files.find(f => {
    const fp = f.path.toLowerCase();
    return fp === lower || fp.endsWith(`/${lower}`);
  });
  return f ? f.content.toLowerCase() : '';
}

export function detectFingerprint(files: FileMap): RepoFingerprint {
  const frameworks: string[] = [];
  const languages: string[] = [];
  const tooling: string[] = [];

  // ── Languages ─────────────────────────────────────────────────────────────
  if (hasFile(files, 'package.json')) {
    languages.push(hasFile(files, 'tsconfig.json') ? 'TypeScript' : 'JavaScript');
  }
  if (hasFile(files, 'requirements.txt') || hasFile(files, 'pyproject.toml') ||
      hasFile(files, 'Pipfile') || hasFile(files, 'setup.py')) {
    languages.push('Python');
  }
  if (hasFile(files, 'go.mod')) languages.push('Go');
  if (hasFile(files, 'Cargo.toml')) languages.push('Rust');
  if (hasFile(files, 'Gemfile')) languages.push('Ruby');
  if (hasFile(files, 'global.json') || hasFile(files, 'NuGet.config')) languages.push('.NET');

  // ── JS/TS Frameworks ──────────────────────────────────────────────────────
  const pkg = fileContent(files, 'package.json');
  if (pkg) {
    if (pkg.includes('"next"'))                         frameworks.push('Next.js');
    else if (pkg.includes('"react"') &&
             (hasFile(files, 'vite.config.ts') || hasFile(files, 'vite.config.js'))) {
      frameworks.push('React+Vite');
    } else if (pkg.includes('"react"'))                frameworks.push('React');
    if (pkg.includes('"vue"'))                         frameworks.push('Vue.js');
    if (pkg.includes('"@angular/core"'))               frameworks.push('Angular');
    if (pkg.includes('"svelte"'))                      frameworks.push('Svelte');
    if (pkg.includes('"@nestjs/core"'))                frameworks.push('NestJS');
    if (pkg.includes('"express"') || pkg.includes('"fastify"')) frameworks.push('Node API');
    if (pkg.includes('"electron"'))                    frameworks.push('Electron');
  }

  // ── Python Frameworks ─────────────────────────────────────────────────────
  if (languages.includes('Python')) {
    const pyDeps = [
      fileContent(files, 'requirements.txt'),
      fileContent(files, 'pyproject.toml'),
      fileContent(files, 'Pipfile'),
    ].join('\n');
    if (pyDeps.includes('fastapi'))       frameworks.push('FastAPI');
    else if (pyDeps.includes('flask'))    frameworks.push('Flask');
    else if (pyDeps.includes('django'))   frameworks.push('Django');
    if (pyDeps.includes('sqlalchemy'))    frameworks.push('SQLAlchemy');
    if (pyDeps.includes('celery'))        frameworks.push('Celery');
  }

  // ── Package managers ──────────────────────────────────────────────────────
  if (hasFile(files, 'pnpm-lock.yaml'))     tooling.push('pnpm');
  else if (hasFile(files, 'yarn.lock'))     tooling.push('yarn');
  else if (hasFile(files, 'package-lock.json')) tooling.push('npm');
  if (hasFile(files, 'pnpm-workspace.yaml')) tooling.push('pnpm-workspaces');

  // ── Containers / infra ────────────────────────────────────────────────────
  if (hasFile(files, 'Dockerfile') || hasFile(files, 'Dockerfile.prod') ||
      hasFile(files, 'Dockerfile.dev'))     tooling.push('Docker');
  if (hasFile(files, 'docker-compose.yml') || hasFile(files, 'docker-compose.yaml')) {
    tooling.push('docker-compose');
  }
  if (hasFile(files, 'main.tf') || hasFile(files, 'terraform.tf')) tooling.push('Terraform');

  // ── Test runners ──────────────────────────────────────────────────────────
  if (hasFile(files, 'jest.config.js') || hasFile(files, 'jest.config.ts') ||
      hasFile(files, 'jest.config.cjs'))    tooling.push('Jest');
  else if (hasFile(files, 'vitest.config.ts') || hasFile(files, 'vitest.config.js')) {
    tooling.push('Vitest');
  }
  if (hasFile(files, 'playwright.config.ts') || hasFile(files, 'playwright.config.js')) {
    tooling.push('Playwright');
  }
  if (hasFile(files, 'cypress.config.ts') || hasFile(files, 'cypress.config.js')) {
    tooling.push('Cypress');
  }

  // ── Node version pinning ──────────────────────────────────────────────────
  if (hasFile(files, '.nvmrc') || hasFile(files, '.node-version')) {
    tooling.push('node-pinned');
  }

  // ── Monorepo detection ────────────────────────────────────────────────────
  const isMonorepo = (
    pkg.includes('"workspaces"') ||
    hasFile(files, 'pnpm-workspace.yaml') ||
    hasFile(files, 'lerna.json') ||
    hasFile(files, 'nx.json') ||
    hasFile(files, 'rush.json')
  );
  if (isMonorepo) tooling.push('monorepo');

  // ── Summary ───────────────────────────────────────────────────────────────
  const parts: string[] = [];
  if (languages.length > 0) parts.push(languages.join('/'));
  if (frameworks.length > 0) parts.push(frameworks.join('+'));
  if (tooling.length > 0) parts.push(`[${tooling.join(', ')}]`);
  const summary = parts.length > 0 ? parts.join(' ') : 'unknown stack';

  return { frameworks, languages, tooling, isMonorepo, summary };
}
