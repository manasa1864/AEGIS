// Fix-catalog fixtures: one realistic failure scenario per error category.
//
// Each entry = a CI log excerpt + the (broken) repo files at the time of the
// failure. The generator runs the REAL rule engine (applyRuleBasedFixes) on it
// and writes the resulting unified diff — so every .diff in fix-catalog/ is
// genuine engine output, and tests/fixCatalog.test.ts fails if a fixer stops
// producing it.
//
// Tiers run from simplest to most complex:
//   1 simple        — one-line CI config / syntax / setup fixes
//   2 code          — surgical edits to application source at the logged file:line
//   3 intermediate  — tests, builds, git, artifacts, caching, pipeline orchestration, runtime
//   4 advanced      — auth, containers, APIs, databases, infrastructure, deployment strategies

import type { ErrorCategory } from '../../src/app/lib/diagnostics';
import { applyRuleBasedFixes } from '../../src/app/lib/ruleBasedFixer';

export type Files = Array<{ path: string; content: string }>;

export interface CatalogEntry {
  /** File-name slug; defaults to the category. */
  id?: string;
  category: ErrorCategory;
  tier: 1 | 2 | 3 | 4;
  title: string;
  log: string;
  /** Files added to / overriding the base repo. */
  files?: Files;
}

export const TIERS: Record<CatalogEntry['tier'], { dir: string; label: string; blurb: string }> = {
  1: { dir: '01-simple', label: 'Simple', blurb: 'Single-line CI configuration, syntax and toolchain-setup fixes.' },
  2: { dir: '02-code', label: 'Source code', blurb: 'Surgical edits to application code at the exact file:line named by the compiler, linter, test runner or stack trace.' },
  3: { dir: '03-intermediate', label: 'Intermediate', blurb: 'Test, build, git, artifact, cache, pipeline-orchestration and runtime failures that need multi-line or multi-file changes.' },
  4: { dir: '04-advanced', label: 'Advanced', blurb: 'Authentication, containers, APIs, databases, infrastructure and deployment strategies.' },
};

// ── Base repository ─────────────────────────────────────────────────────────
// A healthy Node project whose workflow already follows every always-on rule,
// so each diff shows only what the failure's own fixers change.

export const BASE_WORKFLOW = `name: CI
on:
  push:
    branches: [main]
    paths-ignore:
      - '**.md'
      - 'docs/**'
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
env:
  CI: 'true'
  NODE_ENV: test
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test
`;

const PKG = {
  name: 'app', version: '1.0.0', private: true, engines: { node: '>=20' },
  scripts: { build: 'tsc -p .', test: 'vitest run', lint: 'eslint .' },
  dependencies: { express: '^4.19.2' },
  devDependencies: { typescript: '^5.4.0', vitest: '^1.6.0' },
};

export const BASE_FILES: Files = [
  { path: '.github/workflows/ci.yml', content: BASE_WORKFLOW },
  { path: 'package.json', content: JSON.stringify(PKG, null, 2) + '\n' },
  { path: 'package-lock.json', content: '{\n  "name": "app",\n  "lockfileVersion": 3\n}\n' },
  { path: '.nvmrc', content: '20\n' },
  { path: '.editorconfig', content: 'root = true\n' },
  { path: '.env.example', content: 'PORT=3000\n' },
  { path: '.gitignore', content: 'node_modules\n.env\ndist\n' },
];

/** The base workflow with the steps block replaced. */
const wfSteps = (steps: string, jobExtra = '') => BASE_WORKFLOW.replace(
  /    timeout-minutes: 15\n    steps:\n[\s\S]*$/,
  `    timeout-minutes: 15\n${jobExtra}    steps:\n${steps}`,
);
const WF = (content: string) => ({ path: '.github/workflows/ci.yml', content });
const pkg = (patch: Record<string, unknown>) => ({ path: 'package.json', content: JSON.stringify({ ...PKG, ...patch }, null, 2) + '\n' });

const NODE_STEPS = `      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
`;

const DOCKERFILE = 'FROM node\nWORKDIR /app\nCOPY . .\nRUN npm install\nEXPOSE 3000\nCMD npm start\n';

/** A file as the engine's always-on rules leave it when there is NO failure —
 *  i.e. an already-hardened repo, so a scenario's diff shows only its own fix. */
function hardened(path: string, content: string, category: ErrorCategory = 'unknown', extra: Files = []): string {
  return applyRuleBasedFixes(category, '', [{ path, content }, ...extra]).find(f => f.path === path)?.content ?? content;
}
const COMPOSE = `version: "3.8"
services:
  app:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      - db
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
`;
const GITLAB_CI = `stages:
  - build
  - test

build:
  stage: build
  image: node:20
  script:
    - npm ci
    - npm run build

test:
  stage: test
  image: node:20
  script:
    - npm test
`;
const PY_WORKFLOW = wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt
      - run: pytest
`);
const DOCKER_WORKFLOW = wfSteps(`${NODE_STEPS}      - uses: docker/login-action@v3
        with:
          username: \${{ secrets.DOCKERHUB_USERNAME }}
          password: \${{ secrets.DOCKERHUB_TOKEN }}
      - run: docker build -t app:latest .
      - run: docker push app:latest
`);
const DEPLOY_WORKFLOW = wfSteps(`${NODE_STEPS}      - run: npm run build
      - run: kubectl apply -f k8s/deployment.yaml
      - run: curl -f https://app.example.com/health
`);
const K8S_DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      containers:
        - name: app
          image: ghcr.io/acme/app:latest
          ports:
            - containerPort: 3000
`;
const DB_WORKFLOW = wfSteps(`${NODE_STEPS}      - run: npx prisma migrate deploy
      - run: npm test
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/app
`);
const PRISMA = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  orgId Int
}
`;

// Already-hardened variants: scenarios other than docker_build / deploy_failure
// start from these, so their diffs show only the failure-specific fix.
const DOCKERFILE_OK = hardened('Dockerfile', DOCKERFILE, 'docker_build');
const K8S_OK = hardened('k8s/deployment.yaml', K8S_DEPLOYMENT, 'deploy_failure');
const DEPLOY_WORKFLOW_OK = hardened('.github/workflows/ci.yml', DEPLOY_WORKFLOW, 'deploy_failure', [{ path: 'k8s/deployment.yaml', content: K8S_OK }]);
const DEPLOY_REPO = [WF(DEPLOY_WORKFLOW_OK), { path: 'k8s/deployment.yaml', content: K8S_OK }];
const PY_WORKFLOW_OK = hardened('.github/workflows/ci.yml', PY_WORKFLOW, 'python_deps');

export const CATALOG: CatalogEntry[] = [
  // ════════════════════════════ TIER 1 — SIMPLE ════════════════════════════
  {
    category: 'yaml_syntax', tier: 1, title: 'Tab characters in a workflow file',
    log: "Invalid workflow file: .github/workflows/ci.yml#L16\nYou have an error in your yaml syntax on line 16: found character '\\t' that cannot start any token",
    files: [WF(BASE_WORKFLOW.replace('  build:\n    runs-on: ubuntu-latest', '  build:\n\truns-on: ubuntu-latest'))],
  },
  {
    category: 'duplicate_config_key', tier: 1, title: 'Duplicate key in a YAML mapping',
    log: 'Invalid workflow file: .github/workflows/ci.yml#L18\nduplicate mapping key "runs-on"',
    files: [WF(BASE_WORKFLOW.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    runs-on: ubuntu-22.04\n'))],
  },
  {
    category: 'invalid_workflow_syntax', tier: 1, title: 'A step with both `uses:` and `run:`',
    log: 'Invalid workflow file: .github/workflows/ci.yml\nThe workflow file is invalid. a step cannot have both the `uses` and `run` keys',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        run: npm ci
`))],
  },
  {
    category: 'actions_deprecation', tier: 1, title: 'Actions pinned to deprecated runtimes',
    log: 'Warning: Node.js 16 actions are deprecated. Please update the following actions to use Node.js 20: actions/checkout@v2, actions/setup-node@v2',
    files: [WF(BASE_WORKFLOW.replace('actions/checkout@v4', 'actions/checkout@v2').replace('actions/setup-node@v4', 'actions/setup-node@v2'))],
  },
  {
    category: 'node_version', tier: 1, title: 'Workflow Node version older than the project requires',
    log: 'npm ERR! code EBADENGINE\nnpm ERR! engine Unsupported engine\nnpm ERR! notsup Required: {"node":">=20"}\nnpm ERR! notsup Actual:   {"npm":"6.14.18","node":"v14.21.3"}',
    files: [WF(BASE_WORKFLOW.replace('node-version: 20', 'node-version: 14'))],
  },
  {
    category: 'runtime_version_error', tier: 1, title: 'Runtime version does not match `engines`',
    log: 'error app@1.0.0: The engine "node" is incompatible with this module. Expected version ">=20". Got "16.20.2"\nerror Found incompatible module. requires node version >=20',
    files: [WF(BASE_WORKFLOW.replace('node-version: 20', 'node-version: 16'))],
  },
  {
    category: 'missing_dependency', tier: 1, title: 'Dependencies never installed before use',
    log: "Error: Cannot find module 'express'\nRequire stack:\n- /home/runner/work/app/app/server.js\n  code: 'MODULE_NOT_FOUND'",
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
`))],
  },
  {
    category: 'lockfile_corrupt', tier: 1, title: 'Corrupted / out-of-sync lockfile',
    log: 'npm ERR! code EINTEGRITY\nnpm ERR! sha512-abc integrity checksum failed when using sha512: wanted sha512-abc but got sha512-def. (4521 bytes)\nnpm ERR! A complete log of this run can be found in: corrupted lockfile',
  },
  {
    category: 'python_deps', tier: 1, title: 'Python dependency resolution failure',
    log: "ERROR: Could not find a version that satisfies the requirement numpy==1.19.0 (from -r requirements.txt (line 1))\nERROR: No matching distribution found for numpy==1.19.0\nError: Process completed with exit code 1. pip install failed",
    files: [WF(PY_WORKFLOW), { path: 'requirements.txt', content: 'numpy==1.19.0\nrequests\n' }],
  },
  {
    category: 'venv_missing', tier: 1, title: 'Python virtualenv not created / activated',
    log: "/home/runner/work/_temp/abc.sh: line 1: .venv/bin/activate: No such file or directory\nError: .venv activate failed — virtualenv not created",
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: source .venv/bin/activate && pytest
`)), { path: 'requirements.txt', content: 'pytest\n' }],
  },
  {
    category: 'env_missing', tier: 1, title: 'Required environment variable not set',
    log: 'Error: API_URL is required\n    at loadConfig (/home/runner/work/app/app/src/config.js:8:11)\nenv API_URL not set',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: node scripts/smoke.js --url "$API_URL"
`))],
  },
  {
    category: 'secret_missing', tier: 1, title: 'Required secret not configured',
    log: 'Error: Input required and not supplied: token\nEnvironment variable NPM_TOKEN is required but not set\nsecret NPM_TOKEN not set — required',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`))],
  },
  {
    category: 'env_mapping_error', tier: 1, title: 'Secret used in a script but never mapped into `env:`',
    log: 'Error: API_KEY is undefined — env variable not mapped into the step environment\nenvironment injection failed for API_KEY',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: |
          node scripts/smoke.js --key "$API_KEY"
`))],
  },
  {
    category: 'missing_file', tier: 1, title: 'Build references a Dockerfile that does not exist',
    log: 'ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory',
    files: [WF(DOCKER_WORKFLOW)],
  },
  {
    category: 'missing_config_file', tier: 1, title: 'Tool config file missing from the repo',
    log: 'Error: Cannot find config file: vitest.config.ts — config file not found\nNo test config file found',
  },
  {
    category: 'permission_denied', tier: 1, title: 'Script is not executable',
    log: '/home/runner/work/_temp/9a.sh: line 1: ./scripts/deploy.sh: Permission denied\nError: Process completed with exit code 126.',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: ./scripts/deploy.sh
`))],
  },
  {
    category: 'permissions_error', tier: 1, title: 'GITHUB_TOKEN lacks write permissions',
    log: 'HttpError: Resource not accessible by integration\n  status: 403\n  url: https://api.github.com/repos/acme/app/issues/12/comments',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.createComment({ ...context.repo, issue_number: 12, body: 'ok' })
`).replace('permissions:\n  contents: read\n', ''))],
  },
  {
    category: 'job_timeout', tier: 1, title: 'Job exceeded the runner time limit',
    log: 'The job running on runner GitHub Actions 12 has exceeded the maximum execution time of 360 minutes.',
    files: [WF(BASE_WORKFLOW.replace('    timeout-minutes: 15\n', ''))],
  },
  {
    category: 'concurrency_issue', tier: 1, title: 'Runs cancelling each other via concurrency group',
    log: 'Canceling since a higher priority waiting request for \'ci-refs/heads/main\' exists\nThis run has been cancelled by concurrency group',
    files: [WF(BASE_WORKFLOW.replace('concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n', ''))],
  },
  {
    category: 'build_failure', tier: 1, title: 'package.json has no build script',
    log: 'npm ERR! Missing script: "build"\nnpm ERR!\nnpm ERR! To see a list of scripts, run:\nnpm ERR!   npm run\nError: npm run build exited with code 1',
    files: [pkg({ scripts: { test: 'vitest run' } })],
  },
  {
    category: 'lint_failure', tier: 1, title: 'ESLint has no configuration file',
    log: "Oops! Something went wrong! :(\nESLint: 9.4.0\nESLint couldn't find an eslint.config.(js|mjs|cjs) file.",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx eslint .
`))],
  },
  {
    category: 'lint_format_failure', tier: 1, title: 'Prettier check fails with no shared config',
    log: '[warn] src/index.ts\n[warn] Code style issues found in 1 file. Run Prettier with --write to fix.\nPrettier check failed',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx prettier --check .
`))],
  },
  {
    category: 'husky_hook_failure', tier: 1, title: 'Husky hooks installing on the CI runner',
    log: '> app@1.0.0 prepare\n> husky install\n.husky/pre-commit: line 4: lint-staged: command not found\nhusky - pre-commit hook exited with code 127 (error)',
    files: [pkg({ scripts: { ...PKG.scripts, prepare: 'husky install' }, devDependencies: { ...PKG.devDependencies, husky: '^9.0.0' } })],
  },
  {
    category: 'invalid_trigger', tier: 1, title: 'Regex used where a branch glob is expected',
    log: "Workflow was not triggered: branch filter '^release/.*$' is a regular expression — invalid trigger event filter (GitHub uses glob patterns)",
    // function replacement — in a replacement *string*, `$'` means "text after the match"
    files: [WF(BASE_WORKFLOW.replace('    branches: [main]\n', () => "    branches:\n      - '^release/.*$'\n"))],
  },
  {
    category: 'unsupported_config_param', tier: 1, title: 'Removed compiler option in tsconfig',
    log: "error TS5023: Unknown compiler option 'suppressImplicitAnyIndexErrors'.\nunknown option in config — unsupported configuration key",
    files: [{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { target: 'ES2022', strict: true, suppressImplicitAnyIndexErrors: true } }, null, 2) + '\n' }],
  },
  {
    category: 'invalid_gitlab_ci', tier: 1, title: 'Deprecated `only:` / `except:` in .gitlab-ci.yml',
    log: 'Found errors in your .gitlab-ci.yml:\njobs:deploy config contains unknown keys: only\ngitlab ci configuration invalid',
    files: [{ path: '.gitlab-ci.yml', content: GITLAB_CI + '\ndeploy:\n  stage: test\n  image: node:20\n  script:\n    - npm run deploy\n  only:\n    - main\n' }],
  },
  {
    category: 'config_hierarchy_error', tier: 1, title: 'tsconfig `extends` points at a missing base',
    log: "error TS5083: Cannot read file '/home/runner/work/app/app/tsconfig.base.json'.\nextends tsconfig.base.json not found — config inheritance failed",
    files: [{ path: 'tsconfig.json', content: JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { outDir: 'dist' } }, null, 2) + '\n' }],
  },

  // ═════════════════════════════ TIER 2 — CODE ═════════════════════════════
  {
    id: 'code-unused-import-ts', category: 'compilation_failure', tier: 2, title: 'TypeScript unused import (TS6133)',
    log: "src/server.ts(2,10): error TS6133: 'readFile' is declared but its value is never read.\nsrc/server.ts(3,1): error TS6192: All imports in import declaration are unused.",
    files: [{ path: 'src/server.ts', content: "import express from 'express';\nimport { readFile, writeFile } from 'node:fs/promises';\nimport { join } from 'node:path';\n\nconst app = express();\nawait writeFile('boot.log', 'started');\napp.listen(3000);\n" }],
  },
  {
    id: 'code-unused-import-eslint', category: 'lint_failure', tier: 2, title: 'ESLint no-unused-vars on an import',
    log: "/home/runner/work/app/app/src/routes/users.ts\n  1:10  error  'Router' is defined but never used  @typescript-eslint/no-unused-vars\n  2:15  error  'z' is defined but never used  @typescript-eslint/no-unused-vars\n\n✖ 2 problems (2 errors, 0 warnings)",
    files: [{ path: 'src/routes/users.ts', content: "import { Router, type Request } from 'express';\nimport { json, z } from './schema';\n\nexport function listUsers(req: Request) {\n  return json(req.query);\n}\n" }],
  },
  {
    id: 'code-prefer-const', category: 'lint_failure', tier: 2, title: 'ESLint prefer-const',
    log: "/home/runner/work/app/app/src/config.ts\n  3:5  error  'port' is never reassigned. Use 'const' instead  prefer-const\n\n✖ 1 problem (1 error, 0 warnings)",
    files: [{ path: 'src/config.ts', content: "export function config() {\n  const host = process.env.HOST ?? 'localhost';\n  let port = Number(process.env.PORT ?? 3000);\n  return { host, port };\n}\n" }],
  },
  {
    id: 'code-debugger-statement', category: 'lint_failure', tier: 2, title: 'Leftover `debugger` statement',
    log: "/home/runner/work/app/app/src/cart.js\n  5:3  error  Unexpected 'debugger' statement  no-debugger\n\n✖ 1 problem (1 error, 0 warnings)",
    files: [{ path: 'src/cart.js', content: 'export function total(items) {\n  let sum = 0;\n  for (const item of items) {\n    sum += item.price * item.qty;\n    debugger;\n  }\n  return sum;\n}\n' }],
  },
  {
    id: 'code-python-breakpoint', category: 'test_failure', tier: 2, title: 'Leftover `breakpoint()` blocks pytest',
    log: 'tests/test_pricing.py:9: in test_discount\n    breakpoint()\nE   OSError: pytest: reading from stdin while output is captured!  Consider using `-s`.\nFAILED tests/test_pricing.py::test_discount - OSError',
    files: [WF(PY_WORKFLOW_OK), { path: 'requirements.txt', content: 'pytest>=8.0\n' }, { path: 'tests/test_pricing.py', content: 'from app.pricing import discount\n\n\ndef test_full_price():\n    assert discount(100, 0) == 100\n\n\ndef test_discount():\n    breakpoint()\n    assert discount(100, 10) == 90\n' }],
  },
  {
    id: 'code-python-unused-import', category: 'lint_failure', tier: 2, title: 'flake8 / ruff F401 unused import',
    log: "app/pricing.py:1:1: F401 'os' imported but unused\napp/pricing.py:2:1: F401 'typing.Optional' imported but unused\nFound 2 errors.",
    files: [{ path: 'app/pricing.py', content: 'import os, math\nfrom typing import Optional, List\n\n\ndef discount(price: float, pct: float) -> float:\n    return math.floor(price * (100 - pct)) / 100\n\n\ndef bulk(prices: List[float]) -> float:\n    return sum(prices)\n' }],
  },
  {
    id: 'code-whitespace', category: 'lint_failure', tier: 2, title: 'Trailing whitespace / missing final newline',
    log: 'app/models.py:3:30: W291 trailing whitespace\napp/models.py:6:1: W391 blank line at end of file',
    files: [{ path: 'app/models.py', content: 'class User:\n    def __init__(self, name):\n        self.name = name          \n\n\n\n' }],
  },
  {
    id: 'code-focused-tests', category: 'test_failure', tier: 2, title: 'Focused test (`.only`) left in a suite',
    log: ' FAIL  src/cart.test.ts\nError: Unexpected .only modifier. Remove it or pass --allowOnly argument to bypass this error',
    files: [{ path: 'src/cart.test.ts', content: "import { describe, it, expect } from 'vitest';\nimport { total } from './cart';\n\ndescribe('cart', () => {\n  it.only('sums items', () => {\n    expect(total([{ price: 2, qty: 3 }])).toBe(6);\n  });\n  it('handles empty carts', () => {\n    expect(total([])).toBe(0);\n  });\n});\n" }],
  },
  {
    id: 'code-unused-ts-expect-error', category: 'compilation_failure', tier: 2, title: "Unused '@ts-expect-error' (TS2578)",
    log: "src/legacy.ts(4,3): error TS2578: Unused '@ts-expect-error' directive.",
    files: [{ path: 'src/legacy.ts', content: "import { parse } from './parser';\n\nexport function load(raw: string) {\n  // @ts-expect-error — parse() used to return any\n  return parse(raw);\n}\n" }],
  },
  {
    id: 'code-null-deref', category: 'null_reference', tier: 2, title: 'Null dereference at the crashing stack frame',
    log: "TypeError: Cannot read properties of undefined (reading 'email')\n    at formatUser (/home/runner/work/app/app/src/users.js:3:22)\n    at Array.map (<anonymous>)\n    at listUsers (/home/runner/work/app/app/src/users.js:7:16)",
    files: [{ path: 'src/users.js', content: "export function formatUser(user) {\n  const name = user.name ?? 'anonymous';\n  return `${name} <${user.profile.email}>`;\n}\n\nexport function listUsers(users) {\n  return users.map(formatUser);\n}\n" }],
  },
  {
    id: 'code-missing-npm-package', category: 'missing_dependency', tier: 2, title: 'Imported npm package never declared',
    log: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod' imported from /home/runner/work/app/app/src/schema.js\n    at packageResolve (node:internal/modules/esm/resolve:854:9)",
    files: [{ path: 'src/schema.js', content: "import { z } from 'zod';\nexport const User = z.object({ email: z.string().email() });\n" }],
  },
  {
    id: 'code-missing-types', category: 'compilation_failure', tier: 2, title: 'Installed package missing its `@types`',
    log: "src/server.ts(1,21): error TS7016: Could not find a declaration file for module 'express'. '/home/runner/work/app/app/node_modules/express/index.js' implicitly has an 'any' type.",
    files: [{ path: 'src/server.ts', content: "import express from 'express';\nconst app = express();\napp.listen(3000);\n" }],
  },
  {
    id: 'code-missing-python-package', category: 'python_deps', tier: 2, title: 'Imported Python package missing from requirements.txt',
    log: 'Traceback (most recent call last):\n  File "/home/runner/work/app/app/app/config.py", line 2, in <module>\n    import yaml\nModuleNotFoundError: No module named \'yaml\'',
    files: [WF(PY_WORKFLOW_OK), { path: 'requirements.txt', content: 'flask==3.0.3\n' }, { path: 'app/config.py', content: 'import os\nimport yaml\n\nCONFIG = yaml.safe_load(open(os.environ.get("CONFIG", "config.yml")))\n' }],
  },

  // ══════════════════════════ TIER 3 — INTERMEDIATE ═══════════════════════════
  {
    category: 'test_failure', tier: 3, title: 'Jest suite fails / hangs in CI',
    log: 'FAIL src/api.test.js\n  ● API › returns users\n    expect(received).toBe(expected)\nTests: 1 failed, 12 passed, 13 total\nJest did not exit one second after the test run has completed.',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx jest
`)), pkg({ scripts: { ...PKG.scripts, test: 'jest' }, devDependencies: { jest: '^29.7.0' } })],
  },
  {
    category: 'coverage_failure', tier: 3, title: 'Coverage threshold not met',
    log: 'Jest: "global" coverage threshold for lines (80%) not met: 71.4%\nERROR: Coverage for lines (71.4%) does not meet global threshold (80%)\ncoverage threshold not met',
    files: [pkg({ scripts: { ...PKG.scripts, test: 'jest --coverage' }, devDependencies: { jest: '^29.7.0' } }), { path: 'jest.config.js', content: "module.exports = {\n  testEnvironment: 'node',\n  coverageThreshold: { global: { lines: 80 } },\n};\n" }],
  },
  {
    category: 'snapshot_mismatch', tier: 3, title: 'Snapshot mismatch fails CI with no diff to inspect',
    log: '› 1 snapshot failed from 1 test suite. Inspect your code changes or run `npm test -- -u` to update them.\nSnapshot Summary\n › 1 snapshot failed from 1 test suite.',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx jest --ci
`)), pkg({ scripts: { ...PKG.scripts, test: 'jest --ci' }, devDependencies: { jest: '^29.7.0' } })],
  },
  {
    category: 'mock_failure', tier: 3, title: 'Mocks leaking between tests',
    log: 'expect(jest.fn()).toHaveBeenCalledTimes(expected)\nExpected number of calls: 1\nReceived number of calls: 3\nmock not called as expected — spy not invoked with fresh state',
    files: [pkg({ scripts: { ...PKG.scripts, test: 'jest' }, devDependencies: { jest: '^29.7.0' } }), { path: 'jest.config.js', content: "module.exports = {\n  testEnvironment: 'node',\n};\n" }],
  },
  {
    category: 'e2e_failure', tier: 3, title: 'Playwright browsers not installed',
    log: "browserType.launch: Executable doesn't exist at /home/runner/.cache/ms-playwright/chromium-1105/chrome-linux/chrome\nLooks like Playwright Test or Playwright was just installed or updated.\nplaywright browser not found",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx playwright test
`))],
  },
  {
    category: 'compilation_failure', tier: 3, title: 'Third-party type errors block `tsc`',
    log: "node_modules/@types/express-serve-static-core/index.d.ts(1203,24): error TS2344: Type 'T' does not satisfy the constraint.\nsrc/index.ts(1,8): error TS1259: Module can only be default-imported using the 'esModuleInterop' flag\nCompilation failed",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx tsc -p .
`)), { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' } }, null, 2) + '\n' }],
  },
  {
    category: 'memory_error', tier: 3, title: 'Node heap out of memory during build',
    log: '<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n 1: 0xb7a940 node::Abort() [node]',
  },
  {
    category: 'vite_build_failure', tier: 3, title: 'Vite build fails resolving the `@` alias',
    log: '[vite]: Rollup failed to resolve import "@/components/Button" from "src/App.tsx".\nerror during build:\nvite build failed\nCould not resolve "@/components/Button" (vite)',
    files: [{ path: 'vite.config.ts', content: "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n});\n" }],
  },
  {
    category: 'webpack_build_failure', tier: 3, title: 'Webpack compilation runs out of memory',
    log: 'webpack compilation failed\nFATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n<--- JS stacktrace ---> webpack 5.91.0',
    files: [pkg({ scripts: { ...PKG.scripts, build: 'webpack --mode production' }, devDependencies: { webpack: '^5.91.0' } })],
  },
  {
    category: 'go_build_failure', tier: 3, title: 'Go modules not downloaded / toolchain missing',
    log: 'go: downloading github.com/gin-gonic/gin v1.9.1\nmain.go:4:2: no required module provides package github.com/gin-gonic/gin; to add it:\n\tgo get github.com/gin-gonic/gin\ngo build failed',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: go build ./...
      - run: go test ./...
`)), { path: 'go.mod', content: 'module example.com/app\n\ngo 1.22\n' }],
  },
  {
    category: 'rust_build_failure', tier: 3, title: 'Cargo build without toolchain / cache',
    log: 'error[E0433]: failed to resolve: use of undeclared crate or module `tokio`\n --> src/main.rs:3:5\nerror: could not compile `app` (bin "app") due to 1 previous error',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: cargo build --release
      - run: cargo test
`)), { path: 'Cargo.toml', content: '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n' }],
  },
  {
    category: 'dotnet_build_failure', tier: 3, title: '.NET build without SDK setup / restore',
    log: "error NU1101: Unable to find package Newtonsoft.Json. No packages exist with this id in source(s): nuget.org\nBuild FAILED.\ndotnet build FAILED — MSBuild Error",
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: dotnet build --configuration Release
      - run: dotnet test
`))],
  },
  {
    category: 'gradle_build_failure', tier: 3, title: 'Gradle wrapper not executable / no JDK',
    log: "./gradlew: Permission denied\nFAILURE: Build failed with an exception.\n* What went wrong: gradle build failed",
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: ./gradlew build
`)), { path: 'build.gradle', content: "plugins { id 'java' }\nrepositories { mavenCentral() }\n" }],
  },
  {
    category: 'maven_build_failure', tier: 3, title: 'Maven dependency resolution without JDK/cache',
    log: '[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project com.acme:app:jar:1.0: maven\n[INFO] BUILD FAILURE — maven',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: mvn -B package
`)), { path: 'pom.xml', content: '<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>app</artifactId><version>1.0</version></project>\n' }],
  },
  {
    category: 'git_merge_conflict', tier: 3, title: 'Conflict markers committed to a file',
    log: 'CONFLICT (content): Merge conflict in .github/workflows/ci.yml\n<<<<<<< HEAD\nerror: yaml: line 20: could not find expected \':\'',
    files: [WF(BASE_WORKFLOW.replace('      - run: npm test\n', '<<<<<<< HEAD\n      - run: npm test\n=======\n      - run: npm run test:ci\n>>>>>>> feature/ci\n'))],
  },
  {
    category: 'git_push_rejected', tier: 3, title: 'Push from CI rejected as non-fast-forward',
    log: " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/acme/app'\nhint: Updates were rejected because the remote contains work that you do not have locally.\nrejected non-fast-forward",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm version patch && git push
`))],
  },
  {
    category: 'git_submodule_error', tier: 3, title: 'Submodules not checked out',
    log: "fatal: No url found for submodule path 'vendor/sdk' in .gitmodules\nfatal: repository 'vendor/sdk' does not exist — submodule update failed",
  },
  {
    category: 'git_lfs_error', tier: 3, title: 'Git LFS objects not fetched',
    log: 'Error downloading object: assets/model.bin (a1b2c3): Smudge error\nsmudge filter lfs failed\nError: git-lfs pointer file found instead of content',
  },
  {
    category: 'git_tag_failure', tier: 3, title: 'Shallow clone has no tags for `git describe`',
    log: 'fatal: No tags can describe \'5f3c2a1e9d8b\'.\nTry --always, or create some tags.\nsemantic-release: git describe failed',
  },
  {
    category: 'git_credential_failure', tier: 3, title: 'HTTPS git auth has no credentials',
    log: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\nError: git fetch failed — Authentication failed for git",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: git clone https://github.com/acme/private-lib.git lib
`))],
  },
  {
    category: 'git_detached_head', tier: 3, title: 'Detached HEAD blocks commit-and-push',
    log: "HEAD detached at pull/42/merge\nfatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD) state now, use git push origin HEAD:<name>",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: |
          git commit -am "chore: format"
          git push
`))],
  },
  {
    category: 'git_commit_rejected', tier: 3, title: 'Bot commit rejected by author policy',
    log: 'remote: error: GH013: Repository rule violations found for refs/heads/main.\nremote: - Commits must have verified signatures.\n! [remote rejected] main -> main (push declined due to repository rule violations)\ncommit rejected by policy',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: |
          git commit -am "chore: update generated files"
          git push
`))],
  },
  {
    category: 'git_access_denied', tier: 3, title: 'Checkout of a private repo denied',
    log: "remote: Repository not found.\nfatal: repository 'https://github.com/acme/infra.git/' not found or no access\ngit access denied",
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: actions/checkout@v4
        with:
          repository: acme/infra
          path: infra
`))],
  },
  {
    category: 'git_invalid_branch', tier: 3, title: 'Checkout of a branch that does not exist',
    log: "fatal: invalid reference: release\nerror: pathspec 'release' did not match any file(s) known to git",
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
        with:
          ref: release
${NODE_STEPS.replace('      - uses: actions/checkout@v4\n', '')}`))],
  },
  {
    category: 'invalid_branch', tier: 3, title: 'Workflow filters a branch that was renamed',
    log: "error: pathspec 'master' did not match any file(s) known to git\nfatal: invalid reference: master — branch not found",
    files: [WF(BASE_WORKFLOW.replace('branches: [main]', 'branches: [master]'))],
  },
  {
    category: 'artifact_failure', tier: 3, title: 'Artifact upload finds no files',
    log: 'Warning: No files were found with the provided path: dist/. No artifacts will be uploaded.\nError: artifact not found',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: dist
          path: dist/
`))],
  },
  {
    category: 'artifact_retention', tier: 3, title: 'Artifact storage quota / retention',
    log: 'Error: Failed to CreateArtifact: Artifact storage quota has been hit. Unable to upload any new artifacts.\nartifact upload failed',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
`))],
  },
  {
    category: 'artifact_missing', tier: 3, title: 'Download job runs before the upload job',
    log: 'Error: Unable to download artifact(s): Artifact not found for name: build-output\nNo artifact found with name build-output',
    files: [WF(`name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
env:
  CI: 'true'
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: build-output
      - run: ls -la
`)],
  },
  {
    category: 'artifact_upload_failure', tier: 3, title: 'Artifact upload fails on transient error',
    log: 'Error: Failed to upload artifact: Unable to make request: ECONNRESET\nartifact upload failed after 5 attempts',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: actions/upload-artifact@v4
        with:
          name: reports
          path: reports/
`))],
  },
  {
    category: 'cache_failure', tier: 3, title: 'node_modules cache with no restore fallback',
    log: 'Cache not found for input keys: Linux-node-modules-8f14e45\nWarning: Failed to restore cache — cache miss on every run',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: \${{ runner.os }}-node-modules-\${{ hashFiles('package-lock.json') }}
      - run: npm ci
`))],
  },
  {
    category: 'cache_restore_failure', tier: 3, title: 'Cache restore fails with no fallback keys',
    log: 'Warning: Failed to restore cache: Cache service responded with 503\nError restoring cache — cache restore failed',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: \${{ runner.os }}-npm-\${{ hashFiles('package-lock.json') }}
      - run: npm ci
`))],
  },
  {
    category: 'runner_unavailable', tier: 3, title: 'Runner label typo',
    log: 'No hosted runner found matching label: ubuntu-lastest\nWaiting for a runner to pick up this job...',
    files: [WF(BASE_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-lastest'))],
  },
  {
    category: 'matrix_failure', tier: 3, title: 'One matrix leg cancels all others',
    log: 'The strategy configuration was canceled because "build.node_18" failed\nmatrix job cancelled — fail-fast cancelled remaining jobs',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: npm ci && npm test
`, `    strategy:
      matrix:
        node: [18, 20, 22]
`))],
  },
  {
    category: 'circular_dependency', tier: 3, title: 'Jobs that `needs:` each other',
    log: "The workflow is not valid. .github/workflows/ci.yml: Job 'lint' depends on job 'test' which creates a circular dependency",
    files: [WF(`name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
env:
  CI: 'true'
jobs:
  lint:
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo lint
  test:
    needs: lint
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: echo test
`)],
  },
  {
    category: 'stage_order_error', tier: 3, title: 'GitLab job uses an undeclared stage',
    log: 'Found errors in your .gitlab-ci.yml:\ndeploy job: chosen stage does not exist; available stages are .pre, build, test, .post\nstage deploy not defined in pipeline',
    files: [{ path: '.gitlab-ci.yml', content: GITLAB_CI + '\ndeploy:\n  stage: deploy\n  image: node:20\n  script:\n    - npm run deploy\n' }],
  },
  {
    category: 'pipeline_stage_failure', tier: 3, title: 'GitLab stage failure with no retry policy',
    log: 'ERROR: Job failed: exit code 1\nstage test failed — pipeline stage error (runner_system_failure)',
    files: [{ path: '.gitlab-ci.yml', content: GITLAB_CI }],
  },
  {
    category: 'parallel_sync_issue', tier: 3, title: 'Parallel jobs racing on shared state',
    log: 'Error: EEXIST: file already exists, mkdir \'/tmp/test-db\'\nrace condition between parallel jobs — parallel job sync failed',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm test -- --shard=\${{ matrix.shard }}/3
`, `    strategy:
      matrix:
        shard: [1, 2, 3]
`))],
  },
  {
    category: 'null_reference', tier: 3, title: 'NullPointerException with no diagnostics (JVM)',
    log: 'Exception in thread "main" java.lang.NullPointerException\n\tat com.acme.App.main(App.java:14)\nCannot read prop of null',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
      - run: java -jar build/app.jar
`))],
  },
  {
    category: 'type_mismatch', tier: 3, title: 'Type errors only caught at runtime',
    log: "TypeError: value.toFixed is not a function\nsrc/format.ts(8,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    files: [{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, outDir: 'dist' } }, null, 2) + '\n' }],
  },
  {
    category: 'infinite_loop', tier: 3, title: 'Test process never exits',
    log: 'Jest did not exit one second after the test run has completed.\nThis usually means that there are asynchronous operations that weren\'t stopped in your tests.\nprocess hung — job timed out waiting',
    files: [pkg({ scripts: { ...PKG.scripts, test: 'jest' }, devDependencies: { jest: '^29.7.0' } })],
  },
  {
    category: 'stack_overflow', tier: 3, title: 'Recursion exceeds the default stack',
    log: 'RangeError: Maximum call stack size exceeded\n    at walk (/home/runner/work/app/app/src/tree.js:12:10)\nmaximum call stack size exceeded',
  },
  {
    category: 'segfault', tier: 3, title: 'Native crash with no core dump or backtrace',
    log: 'Segmentation fault (core dumped)\nnpm ERR! signal SIGSEGV\nnpm ERR! command sh -c node scripts/render.js',
    files: [WF(wfSteps(`      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: node scripts/render.js
`))],
  },
  {
    category: 'unhandled_exception', tier: 3, title: 'Unhandled promise rejection passes CI silently',
    log: "(node:2231) UnhandledPromiseRejectionWarning: Error: connect ECONNREFUSED 127.0.0.1:6379\n(node:2231) UnhandledPromiseRejectionWarning: Unhandled promise rejection.",
  },

  // ════════════════════════════ TIER 4 — ADVANCED ═════════════════════════════
  {
    category: 'docker_auth', tier: 4, title: 'Docker Hub login fails on PRs / forks',
    log: 'Error: Error response from daemon: Get "https://registry-1.docker.io/v2/": unauthorized: incorrect username or password\nLogin to Docker Hub failed',
    files: [WF(DOCKER_WORKFLOW), { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'docker_build', tier: 4, title: 'Unpinned base image / shell-form CMD',
    log: '#8 [3/4] RUN npm install\n#8 ERROR: process "/bin/sh -c npm install" did not complete successfully: exit code: 1\nERROR: failed to solve: docker build failed (Dockerfile)',
    files: [{ path: 'Dockerfile', content: DOCKERFILE }],
  },
  {
    category: 'docker_rate_limit', tier: 4, title: 'Docker Hub anonymous pull rate limit',
    log: 'Error response from daemon: toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating and upgrading: https://www.docker.com/increase-rate-limit',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: docker build -t app .
`)), { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'dockerfile_syntax', tier: 4, title: 'Invalid Dockerfile instructions',
    log: 'ERROR: failed to solve: dockerfile parse error on line 5: unknown instruction: CMD["node",',
    files: [{ path: 'Dockerfile', content: 'FROM node:20-alpine\nWORKDIR app\nADD . .\nRUN npm ci\nCMD node server.js\n' }],
  },
  {
    category: 'missing_docker_layer', tier: 4, title: 'Docker builds never reuse cached layers',
    log: '#5 importing cache manifest from ghcr.io/acme/app:buildcache\n#5 ERROR: layer not found in cache — cache miss on every layer',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: docker/build-push-action@v5
        with:
          push: false
          tags: app:ci
`)), { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'image_pull_failure', tier: 4, title: 'Service image pull denied / not found',
    log: 'Error response from daemon: pull access denied for acme/api, repository does not exist or may require \'docker login\'\nmanifest unknown docker',
    files: [WF(wfSteps(NODE_STEPS + '      - run: npm test\n', `    services:
      api:
        image: acme/api:latest
`)), { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'registry_auth_failure', tier: 4, title: 'GHCR push without login / packages permission',
    log: 'denied: installation not allowed to Write organization package\nERROR: push access denied to registry ghcr.io — unauthorized registry push',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: docker build -t ghcr.io/acme/app:latest . && docker push ghcr.io/acme/app:latest
`)), { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'container_startup', tier: 4, title: 'Container starts before its dependencies',
    log: 'app-1  | Error: connect ECONNREFUSED 172.18.0.2:5432\napp-1 exited with code 1\ncontainer did not start — container health unhealthy',
    files: [{ path: 'docker-compose.yml', content: COMPOSE }, { path: 'Dockerfile', content: DOCKERFILE_OK }],
  },
  {
    category: 'container_health_failure', tier: 4, title: 'Container has no HEALTHCHECK',
    log: 'container app is unhealthy\nhealth check failed after 3 retries\nError: container unhealthy — dependency failed to start',
    files: [{ path: 'Dockerfile', content: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci --omit=dev\nEXPOSE 3000\nCMD ["node", "server.js"]\n' }, { path: 'docker-compose.yml', content: COMPOSE }],
  },
  {
    category: 'volume_mount_failure', tier: 4, title: 'Bind mount path invalid on the runner',
    log: 'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /data\nvolume mount failed',
    files: [{ path: 'docker-compose.yml', content: COMPOSE.replace('      POSTGRES_PASSWORD: postgres\n', '      POSTGRES_PASSWORD: postgres\n    volumes:\n      - /data:/var/lib/postgresql/data\n') }],
  },
  {
    category: 'port_conflict', tier: 4, title: 'Port already allocated on the runner',
    log: 'Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:5432 failed: port is already allocated\nError: listen EADDRINUSE: address already in use :::3000',
    files: [{ path: 'docker-compose.yml', content: COMPOSE.replace('      POSTGRES_PASSWORD: postgres\n', '      POSTGRES_PASSWORD: postgres\n    ports:\n      - "5432:5432"\n') }],
  },
  {
    category: 'invalid_token', tier: 4, title: 'Expired / invalid API token',
    log: 'HttpError: Bad credentials\n  status: 401 Unauthorized\ntoken expired or revoked',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: gh release create v1.0.0
        env:
          GH_TOKEN: \${{ secrets.RELEASE_TOKEN }}
`))],
  },
  {
    category: 'oauth_failure', tier: 4, title: 'OAuth token missing a required scope',
    log: 'OAuthError: insufficient_scope — required scope not granted: read:org\nHttpError: oauth token invalid for this operation',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm run e2e
        env:
          OAUTH_CLIENT_ID: \${{ secrets.OAUTH_CLIENT_ID }}
`))],
  },
  {
    category: 'ssh_key_error', tier: 4, title: 'SSH deploy fails host key verification',
    log: 'Host key verification failed.\nerr: ssh: handshake failed: knownhosts: key is unknown\nProcess exited with status 1',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: appleboy/ssh-action@v1
        with:
          host: \${{ secrets.PROD_HOST }}
          username: deploy
          key: \${{ secrets.SSH_PRIVATE_KEY }}
          script: cd app && git pull && pm2 reload all
`))],
  },
  {
    category: 'oidc_failure', tier: 4, title: 'OIDC token request without id-token permission',
    log: 'Error: Could not get ID token for authentication — oidc token request failed\nError: Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/ci
          aws-region: us-east-1
`))],
  },
  {
    category: 'aws_auth_failure', tier: 4, title: 'AWS CLI with no credentials / region',
    log: 'Unable to locate credentials. You can configure credentials by running "aws configure".\nNoCredentialProviders: no valid providers in chain',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: aws s3 sync dist/ s3://acme-app
`))],
  },
  {
    category: 'gcp_auth_failure', tier: 4, title: 'gcloud without authentication',
    log: 'ERROR: (gcloud.run.deploy) You do not currently have an active account selected.\nGOOGLE_APPLICATION_CREDENTIALS is not set — gcloud auth failed',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: gcloud run deploy app --source . --region us-central1
`))],
  },
  {
    category: 'secret_access_denied', tier: 4, title: 'Environment secret used outside its environment',
    log: "Error: Input required and not supplied: deploy-key\nenvironment secret not accessible — this secret is only available to jobs that reference the 'production' environment",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm run deploy
        env:
          DEPLOY_KEY: \${{ secrets.DEPLOY_KEY }}
`))],
  },
  {
    category: 'insufficient_role', tier: 4, title: 'IAM role lacks a required action',
    log: 'An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:sts::1:assumed-role/ci is not authorized to perform: s3:PutObject on resource: arn:aws:s3:::acme-app/*',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/ci
          aws-region: us-east-1
      - run: aws s3 sync dist/ s3://acme-app
`))],
  },
  {
    category: 'cross_project_access', tier: 4, title: 'Checking out another private repository',
    log: "remote: Repository not found.\nfatal: repository 'https://github.com/acme/shared-config/' not found\ncross project access denied",
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: actions/checkout@v4
        with:
          repository: acme/shared-config
          path: shared
`))],
  },
  {
    category: 'api_timeout', tier: 4, title: 'Network call times out with no retry',
    log: 'curl: (28) Operation timed out after 30001 milliseconds with 0 bytes received\nError: connect ETIMEDOUT 52.10.1.2:443',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: curl -sS https://api.example.com/v1/health
`))],
  },
  {
    category: 'api_rate_limit', tier: 4, title: 'GitHub API secondary rate limit',
    log: 'HttpError: API rate limit exceeded for installation ID 12345.\nstatus: 429 Too Many Requests\nx-ratelimit-remaining: 0',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: gh api repos/acme/app/pulls --paginate
`))],
  },
  {
    category: 'invalid_api_response', tier: 4, title: 'Script parses an error page as JSON',
    log: "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON\nAPI returned 502 — unexpected response from API",
    files: [WF(wfSteps(`${NODE_STEPS}      - run: curl -s https://api.example.com/v1/config | jq .version
`))],
  },
  {
    category: 'rest_endpoint_mismatch', tier: 4, title: 'Contract check calls an unversioned endpoint',
    log: 'curl: (22) The requested URL returned error: 404 — endpoint not found: GET /users (the API is served under /api/v1/)',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: curl https://staging.example.com/users --fail --silent
`))],
  },
  {
    category: 'webhook_failure', tier: 4, title: 'Webhook signature verification fails',
    log: 'Error: webhook signature invalid — X-Hub-Signature-256 mismatch\ninvalid webhook secret configured',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npm run test:webhooks
`))],
  },
  {
    category: 'third_party_failure', tier: 4, title: 'Third-party scanner outage blocks the build',
    log: 'Snyk API request failed: third-party service returned 503\nexternal service unavailable — SonarCloud quality gate timed out',
    files: [WF(wfSteps(`${NODE_STEPS}      - uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: \${{ secrets.SNYK_TOKEN }}
`))],
  },
  {
    category: 'schema_validation', tier: 4, title: 'OpenAPI lint gate blocks every build',
    log: 'openapi.yaml\n  12:7  error  oas3-schema  "responses" property must have required property "200".\nschema validation failed — JSON Schema error',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: npx @stoplight/spectral-cli lint openapi.yaml
`)), { path: 'openapi.yaml', content: 'openapi: 3.0.3\ninfo:\n  title: App\n  version: 1.0.0\npaths:\n  /users:\n    get:\n      responses: {}\n' }],
  },
  {
    category: 'graphql_failure', tier: 4, title: 'GraphQL smoke query against a changed schema',
    log: 'GraphQLError: Cannot query field "fullName" on type "User". Did you mean "name"?\nUnknown argument "first" on field "users" — GraphQL validation failed',
    files: [WF(wfSteps(`${NODE_STEPS}      - run: curl -sf -X POST -H "Content-Type:application/json" -d @queries/users.json https://api.example.com/graphql
`))],
  },
  {
    category: 'db_connection_error', tier: 4, title: 'Tests start before the database service',
    log: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)\nPrismaClientInitializationError: Can\'t reach database server at `localhost:5432`',
    files: [WF(DB_WORKFLOW), { path: 'prisma/schema.prisma', content: PRISMA }],
  },
  {
    category: 'db_migration_error', tier: 4, title: 'Migrations fail on a fresh CI database',
    log: 'Error: P3009\nmigrate found failed migrations in the target database, new migrations will not be applied.\nThe `20240501_add_org` migration failed — migration failed',
    files: [WF(DB_WORKFLOW), { path: 'prisma/schema.prisma', content: PRISMA }],
  },
  {
    category: 'db_schema_mismatch', tier: 4, title: 'Prisma client out of sync with the schema',
    log: 'PrismaClientInitializationError: The table `public.User` does not exist in the current database.\nschema drift detected — unapplied migration',
    files: [WF(DB_WORKFLOW), { path: 'prisma/schema.prisma', content: PRISMA }],
  },
  {
    category: 'db_query_failure', tier: 4, title: 'Query fails with no diagnostics',
    log: 'QueryFailedError: canceling statement due to statement timeout\nquery execution failed: SELECT * FROM orders WHERE org_id = $1',
    files: [WF(DB_WORKFLOW)],
  },
  {
    category: 'db_deadlock', tier: 4, title: 'Parallel tests deadlock the database',
    log: 'error: deadlock detected\nDETAIL: Process 1432 waits for ShareLock on transaction 5521; blocked by process 1433.\nER_LOCK_DEADLOCK',
    files: [WF(DB_WORKFLOW)],
  },
  {
    category: 'missing_db_index', tier: 4, title: 'Sequential scan on a foreign key',
    log: 'Seq Scan on "User"  (cost=0.00..18334.00 rows=1 width=40)\n  Filter: ("orgId" = 42)\nslow query — missing index hint on User.orgId',
    files: [{ path: 'prisma/schema.prisma', content: PRISMA }],
  },
  {
    category: 'transaction_rollback', tier: 4, title: 'Transaction rolled back with no retry/timeout',
    log: 'PrismaClientKnownRequestError: Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction.\ntransaction rolled back',
    files: [WF(DB_WORKFLOW), { path: 'prisma/schema.prisma', content: PRISMA }],
  },
  {
    category: 'db_replication_lag', tier: 4, title: 'Reads from a lagging replica',
    log: 'Error: replication lag 43s exceeds threshold 5s — replica behind primary\nstale read detected on read replica',
    files: [WF(DB_WORKFLOW)],
  },
  {
    category: 'terraform_failure', tier: 4, title: 'Terraform apply without init/plan',
    log: 'Error: Backend initialization required, please run "terraform init"\nError: terraform plan failed — Terraform exited with code 1',
    files: [WF(wfSteps(`      - uses: actions/checkout@v4
      - run: terraform apply -auto-approve
`)), { path: 'main.tf', content: 'provider "aws" {\n  region = "us-east-1"\n}\n' }],
  },
  {
    category: 'service_unavailable', tier: 4, title: 'Deploy targets a service returning 503',
    log: 'curl: (22) The requested URL returned error: 503 Service Unavailable\n502 Bad Gateway during deploy',
    files: DEPLOY_REPO,
  },
  {
    category: 'health_check_failure', tier: 4, title: 'Post-deploy health check fails immediately',
    log: 'health check failed: GET /health returned 503\nReadiness probe failed: HTTP probe failed with statuscode: 503',
    files: [WF(DEPLOY_WORKFLOW), { path: 'k8s/deployment.yaml', content: K8S_DEPLOYMENT }],
  },
  {
    category: 'load_balancer_issue', tier: 4, title: 'Load balancer marks targets unhealthy',
    log: 'ALB target group health check failing: 503 Service Unavailable from load balancer\nTarget.ResponseCodeMismatch',
    files: DEPLOY_REPO,
  },
  {
    category: 'deploy_failure', tier: 4, title: 'Deployment fails with no rollback',
    log: 'error: deployment "app" exceeded its progress deadline\nDeployment failed — Failed to deploy revision 42',
    files: [WF(DEPLOY_WORKFLOW), { path: 'k8s/deployment.yaml', content: K8S_DEPLOYMENT }],
  },
  {
    category: 'failed_production_deploy', tier: 4, title: 'Production deploy with no gate or guard',
    log: 'production deploy failed: release v2.3.0 crashed on boot\nError: deploy to production error — rollout aborted',
    files: [WF(DEPLOY_WORKFLOW), { path: 'k8s/deployment.yaml', content: K8S_DEPLOYMENT }],
  },
  {
    category: 'rollback_failure', tier: 4, title: 'Rollback itself fails',
    log: 'error: no rollout history found for deployment "app"\nrollback failed — failed to rollback to revision 41',
    files: [WF(DEPLOY_WORKFLOW), { path: 'k8s/deployment.yaml', content: K8S_DEPLOYMENT }],
  },
  {
    category: 'blue_green_conflict', tier: 4, title: 'Blue/green traffic switch conflict',
    log: 'Error: blue green conflict — both slots report active\ntraffic switch failed: service selector already points to green',
    files: DEPLOY_REPO,
  },
  {
    category: 'canary_mismatch', tier: 4, title: 'Canary serving a different version',
    log: 'canary version mismatch: canary=v2.4.0 stable=v2.3.1 — canary deploy error\nerror rate 7.2% exceeds threshold 1%',
    files: [WF(DEPLOY_WORKFLOW), { path: 'k8s/deployment.yaml', content: K8S_DEPLOYMENT }],
  },
];
