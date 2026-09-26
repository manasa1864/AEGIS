// Repair-only healing: the policy that keeps fix PRs to real repairs, the
// masking guard, and the general repair rules (manifests per job directory,
// lint/compiler fixes, infra manifests, tree-based context resolution).

import { describe, it, expect } from 'vitest';
import { applyRuleBasedFixes, maskingReason } from '../src/app/lib/ruleBasedFixer';
import { workflowJobs, jobDirectories, nearestFile } from '../src/app/lib/fixers/workflowJobs';
import {
  fixNodeEngineMismatch, fixUnavailablePinnedVersion, fixIncompatiblePythonPins, fixVulnerableDependencies,
  fixJestEnvironmentMissing, fixMissingRequirementsFile, fixVirtualenvNotCreated, fixMissingNpmPackage,
  buildOutputDir, majorSatisfies,
} from '../src/app/lib/fixers/code/manifests';
import {
  fixEslintRuleViolations, fixPythonLintViolations, fixMissingExport, fixPythonModulePath, fixPyYamlLoad,
  fixNullDerefAtStackFrame,
} from '../src/app/lib/fixers/code/source';
import {
  fixComposeHostPortCollision, fixK8sSelectorLabelMismatch, fixDockerfilePath, fixDockerfileUnknownInstruction, fixMissingBindSource,
} from '../src/app/lib/fixers/advanced/infraStatic';
import { fixInvalidCronExpression, fixChmodScript } from '../src/app/lib/fixers/simple/syntax';
import { fixDownloadAfterUpload } from '../src/app/lib/fixers/intermediate/pipeline';
import { contextCandidates } from '../src/app/lib/contextBuilder';
import { categorizeAllErrors } from '../src/app/lib/diagnostics';

const MONOREPO_CI = `name: CI
on: [push]
jobs:
  api:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: services/api
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 16
      - run: npm install
  web:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [16, 18, 20]
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: npm install
  worker:
    runs-on: ubuntu-latest
    steps:
      - run: pip install -r requirements.txt
        working-directory: services/worker
      - run: pytest
        working-directory: services/worker
`;
const wf = { path: '.github/workflows/ci.yml', content: MONOREPO_CI };
const pkgJson = (path: string, body: object) => ({ path, content: JSON.stringify(body, null, 2) + '\n' });

describe('repair-only policy', () => {
  const healthy = [
    { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n      - run: pip install -r requirements.txt\n      - run: pytest\n' },
    { path: 'requirements.txt', content: 'pytest==8.3.2\n' },
    { path: 'Dockerfile', content: 'FROM python:3.12\nCOPY . .\nCMD python app.py\n' },
  ];

  it('changes nothing on a repo whose config is valid, even when a category is diagnosed', () => {
    expect(applyRuleBasedFixes(['python_deps', 'docker_build', 'invalid_workflow_syntax'], '', healthy)).toEqual([]);
  });

  it('still offers the optional hardening when asked', () => {
    expect(applyRuleBasedFixes(['python_deps'], '', healthy, { hardening: true }).length).toBeGreaterThan(0);
  });

  it('keeps static repairs for definitions that are invalid on their own', () => {
    const broken = [{ path: '.github/workflows/n.yml', content: 'name: N\non:\n  schedule:\n    - cron: "0 25 * * *"\njobs:\n  a:\n    runs-on: ubuntu-18.04\n    steps:\n      - run: echo hi\n' }];
    const [fix] = applyRuleBasedFixes('unknown', '', broken);
    expect(fix.content).toContain("cron: \"0 23 * * *\"");
    expect(fix.content).not.toContain('ubuntu-18.04');
  });
});

describe('masking guard', () => {
  it('flags edits that silence a check instead of fixing it', () => {
    expect(maskingReason('steps:\n  - run: npm test\n', 'steps:\n  - run: npm test\n    continue-on-error: true\n')).toMatch(/non-blocking/);
    expect(maskingReason('run: npm audit\n', 'run: npm audit || true\n')).toMatch(/exit code/);
    expect(maskingReason('coverageThreshold: { global: { lines: 80 } }', 'coverageThreshold: { global: { lines: 70 } }')).toMatch(/lines coverage threshold \(80 → 70\)/);
    expect(maskingReason('lines: 80', 'lines: 90')).toBeNull();
    expect(maskingReason(undefined, 'run: npm ci\n')).toBeNull();
  });
});

describe('workflow jobs', () => {
  it('finds each job, its working directory and runtime versions', () => {
    const jobs = workflowJobs(wf.path, wf.content);
    expect(jobs.map(j => [j.id, j.workingDirectory])).toEqual([['api', 'services/api'], ['web', 'web'], ['worker', 'services/worker']]);
    expect(jobs[0].nodeVersions.map(v => v.value)).toEqual(['16']);
    expect(jobDirectories([wf]).sort()).toEqual(['services/api', 'services/worker', 'web']);
  });

  it('nearestFile walks up to the governing manifest', () => {
    const files = [{ path: 'package.json' }, { path: 'services/api/package.json' }];
    expect(nearestFile(files, 'services/api/src/a.ts', /^package\.json$/)?.path).toBe('services/api/package.json');
    expect(nearestFile(files, 'web/src/a.ts', /^package\.json$/)?.path).toBe('package.json');
  });
});

describe('manifest repairs', () => {
  it('majorSatisfies understands the common engines ranges', () => {
    expect(majorSatisfies('>=18', 16)).toBe(false);
    expect(majorSatisfies('>=18', 20)).toBe(true);
    expect(majorSatisfies('^18 || ^20', 20)).toBe(true);
    expect(majorSatisfies('>=18 <21', 22)).toBe(false);
    expect(majorSatisfies('18.x', 18)).toBe(true);
  });

  it('raises the failing job and drops unsupported matrix legs, using a version the repo already runs', () => {
    const files = [
      wf,
      pkgJson('services/api/package.json', { name: 'api', engines: { node: '>=18' } }),
      pkgJson('web/package.json', { name: 'web', engines: { node: '>=18' } }),
    ];
    const [fix] = fixNodeEngineMismatch('npm ERR! code EBADENGINE', files);
    expect(fix.content).toContain('        node: [18, 20]');
    expect(fix.content).toMatch(/node-version: (?:18|20)\n/);
    expect(fix.content).not.toContain('node-version: 16');
  });

  it('does nothing without an engine error unless engine-strict makes it certain', () => {
    const files = [wf, pkgJson('services/api/package.json', { name: 'api', engines: { node: '>=18' } })];
    expect(fixNodeEngineMismatch('', files)).toEqual([]);
    expect(fixNodeEngineMismatch('', [...files, { path: 'services/api/.npmrc', content: 'engine-strict=true\n' }])).toHaveLength(1);
  });

  it('replaces an unpublished pip pin with the newest final release pip listed', () => {
    const log = 'ERROR: Could not find a version that satisfies the requirement redis==9.9.9 (from versions: 4.6.0, 5.0.0, 5.1.0b1, 5.0.8)\nERROR: No matching distribution found for redis==9.9.9';
    const [fix] = fixUnavailablePinnedVersion(log, [{ path: 'services/worker/requirements.txt', content: 'redis==9.9.9  # cache\npytest==8.3.2\n' }]);
    expect(fix.path).toBe('services/worker/requirements.txt');
    expect(fix.content).toBe('redis==5.0.8  # cache\npytest==8.3.2\n');
  });

  it('hands an unpublished npm version to the resolver', () => {
    const [fix] = fixUnavailablePinnedVersion('npm ERR! notarget No matching version found for express@9.9.9.', [pkgJson('package.json', { dependencies: { express: '9.9.9' } })]);
    expect(JSON.parse(fix.content).dependencies.express).toBe('latest');
  });

  it('upgrades pins that cannot build, and packages too old for their own dependency', () => {
    const log = 'Collecting Pillow==8.0.0\n  error: subprocess-exited-with-error\nERROR: Failed building wheel for Pillow\n' +
      'Traceback (most recent call last):\n  File "/opt/hostedtoolcache/Python/3.11/x64/lib/python3.11/site-packages/jinja2/utils.py", line 6, in <module>\n' +
      "ImportError: cannot import name 'soft_unicode' from 'markupsafe' (/opt/site-packages/markupsafe/__init__.py)";
    const [fix] = fixIncompatiblePythonPins(log, [{ path: 'requirements.txt', content: 'Pillow==8.0.0\nJinja2==2.10\nredis==5.0.8\n' }]);
    expect(fix.content).toBe('Pillow\nJinja2\nredis==5.0.8\n');
  });

  it('moves vulnerable direct dependencies to the first patched release (npm audit and pip-audit)', () => {
    const npmLog = 'express  <4.20.0\nSeverity: high\nfix available via `npm audit fix`\n\nqs  <6.10.3\nSeverity: high\nDepends on vulnerable versions of express';
    const [npm] = fixVulnerableDependencies(npmLog, [pkgJson('package.json', { dependencies: { express: '4.16.0', lodash: '^4.17.21' } })]);
    expect(JSON.parse(npm.content).dependencies).toEqual({ express: '^4.20.0', lodash: '^4.17.21' });

    const pyLog = 'Name    Version ID                  Fix Versions\n------- ------- ------------------- ------------\njinja2  2.10    PYSEC-2019-217      2.10.1\njinja2  2.10    GHSA-h5c8-rqwp-cp95 3.1.3\n';
    const [py] = fixVulnerableDependencies(pyLog, [{ path: 'requirements.txt', content: 'Jinja2==2.10\n' }]);
    expect(py.content).toBe('Jinja2==3.1.3\n');
  });

  it("switches a DOM-less package to Jest's node environment, or installs jsdom for UI code", () => {
    const cfg = { path: 'jest.config.js', content: "module.exports = { testEnvironment: 'jsdom' };\n" };
    const [node] = fixJestEnvironmentMissing('', [cfg, pkgJson('package.json', { devDependencies: { jest: '^29.7.0' } })]);
    expect(node.content).toContain("testEnvironment: 'node'");
    const [dom] = fixJestEnvironmentMissing('', [cfg, pkgJson('package.json', { dependencies: { react: '^18.2.0' }, devDependencies: { jest: '^29.7.0' } })]);
    expect(JSON.parse(dom.content).devDependencies['jest-environment-jsdom']).toBe('latest');
    expect(fixJestEnvironmentMissing('', [cfg, pkgJson('package.json', { devDependencies: { jest: '^27.0.0' } })])).toEqual([]);
  });

  it("creates a missing requirements file in the job's working directory, not at the root", () => {
    const [fix] = fixMissingRequirementsFile("ERROR: Could not open requirements file: [Errno 2] No such file or directory: 'requirements.txt'", [wf]);
    expect(fix.path).toBe('services/worker/requirements.txt');
  });

  it('creates the virtualenv a job activates but never created', () => {
    const w = { path: '.github/workflows/ci.yml', content: 'jobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: source .venv/bin/activate && pytest\n' };
    const [fix] = fixVirtualenvNotCreated('line 1: .venv/bin/activate: No such file or directory', [w, { path: 'requirements.txt', content: 'pytest\n' }]);
    expect(fix.content).toContain('      - name: Create virtual environment\n        run: |\n          python3 -m venv .venv\n          .venv/bin/pip install -r requirements.txt\n      - run: source .venv/bin/activate');
  });

  it('declares a missing package in the package that imports it, and never guesses between several', () => {
    const files = [
      pkgJson('package.json', { name: 'root', private: true }),
      pkgJson('services/api/package.json', { name: 'api', dependencies: {} }),
      { path: 'services/api/src/a.ts', content: "import { v4 } from 'uuid';\n" },
    ];
    const [fix] = fixMissingNpmPackage("src/a.ts(1,20): error TS2307: Cannot find module 'uuid' or its corresponding type declarations.", files);
    expect(fix.path).toBe('services/api/package.json');
    expect(fixMissingNpmPackage("Cannot find module 'uuid'", files.slice(0, 2))).toEqual([]);
  });

  it('knows where common build tools write their output', () => {
    expect(buildOutputDir([pkgJson('web/package.json', { scripts: { build: 'vite build' } }), { path: 'web/vite.config.ts', content: "export default { build: { outDir: 'public' } }" }], 'web')).toBe('web/public');
    expect(buildOutputDir([pkgJson('package.json', { scripts: { build: 'react-scripts build' } })], '')).toBe('build');
    expect(buildOutputDir([pkgJson('package.json', { scripts: { build: 'tsc' } }), { path: 'tsconfig.json', content: '{ "compilerOptions": { "outDir": "lib" } }' }], '')).toBe('lib');
    expect(buildOutputDir([pkgJson('package.json', { scripts: { build: 'make' } })], '')).toBeNull();
  });
});

describe('code repairs', () => {
  it('drops an unused local only when its initializer has no side effects', () => {
    const log = '/home/runner/work/a/a/src/x.ts\n  2:9  error  \'loc\' is assigned a value but never used  @typescript-eslint/no-unused-vars\n  3:9  error  \'res\' is assigned a value but never used  @typescript-eslint/no-unused-vars';
    const [fix] = fixEslintRuleViolations(log, [{ path: 'src/x.ts', content: 'export function f(row: { location: string }) {\n  const loc = row.location;\n  const res = save(row);\n}\n' }]);
    expect(fix.content).toBe('export function f(row: { location: string }) {\n  const res = save(row);\n}\n');
  });

  it('leaves a multi-line console call alone', () => {
    const log = '/home/runner/work/a/a/src/x.ts\n  1:1  error  Unexpected console statement  no-console';
    expect(fixEslintRuleViolations(log, [{ path: 'src/x.ts', content: 'console.log({\n  a: 1,\n});\n' }])).toEqual([]);
  });

  it('keeps a real f-string and only rewrites the reported mutable default', () => {
    const log = 'app.py:1:14: F541 f-string without any placeholders\napp.py:4:1: B006 Do not use mutable data structures for argument defaults';
    const src = 'x = f"{name}"\n\n\ndef add(item, seen=[]):\n    seen.append(item)\n    return seen\n';
    const [fix] = fixPythonLintViolations(log, [{ path: 'app.py', content: src }]);
    expect(fix.content).toBe('x = f"{name}"\n\n\ndef add(item, seen=None):\n    if seen is None:\n        seen = []\n    seen.append(item)\n    return seen\n');
  });

  it('exports a declared-but-unexported name (TS2305) and ignores names the module does not declare', () => {
    const files = [
      { path: 'src/server.ts', content: 'function start() {}\nconst port = 3000;\n' },
      { path: 'test/server.test.ts', content: "import { start, stop } from '../src/server';\n" },
    ];
    const log = "test/server.test.ts(1,10): error TS2305: Module '\"../src/server\"' has no exported member 'start'.\ntest/server.test.ts(1,17): error TS2305: Module '\"../src/server\"' has no exported member 'stop'.";
    const [fix] = fixMissingExport(log, files);
    expect(fix.content).toBe('export function start() {}\nconst port = 3000;\n');
  });

  it('does not relocate an import when the module name is ambiguous', () => {
    const files = [
      { path: 'pkg/a/util.py', content: '' }, { path: 'pkg/b/util.py', content: '' },
      { path: 'tests/test_x.py', content: 'from pkg.util import f\n' },
    ];
    const log = "ImportError while importing test module '/home/runner/work/r/r/tests/test_x.py'.\nE   ModuleNotFoundError: No module named 'pkg.util'";
    expect(fixPythonModulePath(log, files)).toEqual([]);
  });

  it('switches yaml.load to safe_load only at the frame that failed', () => {
    const log = 'Traceback (most recent call last):\n  File "/home/runner/work/r/r/cfg.py", line 2, in load\n    return yaml.load(f)\nTypeError: load() missing 1 required positional argument: \'Loader\'';
    const [fix] = fixPyYamlLoad(log, [{ path: 'cfg.py', content: 'def load(f):\n    return yaml.load(f)\n\ndef other(f):\n    return yaml.load(f, Loader=yaml.FullLoader)\n' }]);
    expect(fix.content).toBe('def load(f):\n    return yaml.safe_load(f)\n\ndef other(f):\n    return yaml.load(f, Loader=yaml.FullLoader)\n');
  });

  it('prefers fixing an off-by-one loop bound over guarding the access', () => {
    const log = "TypeError: Cannot read properties of undefined (reading 'qty')\n    at total (/home/runner/work/r/r/src/p.ts:3:18)";
    const [fix] = fixNullDerefAtStackFrame(log, [{ path: 'src/p.ts', content: 'let s = 0;\nfor (let i = 0; i <= items.length; i++) {\n  s += items[i].qty;\n}\n' }]);
    expect(fix.content).toContain('i < items.length');
    expect(fix.content).not.toContain('?.');
  });
});

describe('infrastructure repairs', () => {
  it('clamps out-of-range cron fields, quoted or not', () => {
    const [fix] = fixInvalidCronExpression([{ path: '.github/workflows/n.yml', content: 'on:\n  schedule:\n    - cron: 70 25 32 13 *\n' }]);
    expect(fix.content).toContain("cron: '59 23 31 12 *'");
  });

  it('moves only the second service off a shared host port', () => {
    const [fix] = fixComposeHostPortCollision([{ path: 'docker-compose.yml', content: 'services:\n  a:\n    ports:\n      - "8080:80"\n  b:\n    ports:\n      - "8080:8080"\n      - "8081:9000"\n' }]);
    expect(fix.content).toBe('services:\n  a:\n    ports:\n      - "8080:80"\n  b:\n    ports:\n      - "8082:8080"\n      - "8081:9000"\n');
  });

  it('aligns template labels with the selector unless a Service selects the old labels', () => {
    const dep = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  selector:\n    matchLabels:\n      app: api\n  template:\n    metadata:\n      labels:\n        app: shop\n        tier: web\n    spec:\n      containers: []\n';
    const [fix] = fixK8sSelectorLabelMismatch([{ path: 'k8s/api.yaml', content: dep }]);
    expect(fix.content).toContain('      labels:\n        app: api\n        tier: web\n');
    const svc = '---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector:\n    app: shop\n';
    expect(fixK8sSelectorLabelMismatch([{ path: 'k8s/api.yaml', content: dep + svc }])).toEqual([]);
  });

  it('points docker build at the only Dockerfile, and corrects a misspelled instruction', () => {
    const w = { path: '.github/workflows/ci.yml', content: 'jobs:\n  b:\n    steps:\n      - run: docker build -t app .\n' };
    const [p] = fixDockerfilePath('ERROR: failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory', [w, { path: 'docker/api.Dockerfile', content: 'FROM node\n' }]);
    expect(p.content).toContain('docker build -f docker/api.Dockerfile -t app .');
    const [i] = fixDockerfileUnknownInstruction('dockerfile parse error on line 2: unknown instruction: COPPY', [{ path: 'Dockerfile', content: 'FROM node:20\nCOPPY . .\n' }]);
    expect(i.content).toBe('FROM node:20\nCOPY . .\n');
  });

  it('swaps a missing host bind mount for a named volume', () => {
    const [fix] = fixMissingBindSource('bind source path does not exist: /srv/pg', [{ path: 'docker-compose.yml', content: 'services:\n  db:\n    volumes:\n      - /srv/pg:/var/lib/postgresql/data\n' }]);
    expect(fix.content).toBe('services:\n  db:\n    volumes:\n      - pg-data:/var/lib/postgresql/data\n\nvolumes:\n  pg-data:\n');
  });

  it('adds chmod for any script the log says is not executable', () => {
    const w = { path: '.github/workflows/ci.yml', content: 'jobs:\n  b:\n    steps:\n      - run: ./gradlew build\n      - run: ./gradlew-wrapper\n' };
    const [fix] = fixChmodScript('/home/runner/work/_temp/x.sh: line 1: ./gradlew: Permission denied', [w]);
    expect(fix.content).toContain('run: chmod +x ./gradlew && ./gradlew build');
    expect(fix.content).toContain('run: ./gradlew-wrapper');
  });

  it('orders a download after its upload even when the artifact name contains the job id', () => {
    const w = { path: '.github/workflows/ci.yml', content: 'jobs:\n  build:\n    steps:\n      - uses: actions/upload-artifact@v4\n        with:\n          name: build-output\n  deploy:\n    steps:\n      - name: Fetch\n        uses: actions/download-artifact@v4\n        with:\n          name: build-output\n' };
    const [fix] = fixDownloadAfterUpload([w]);
    expect(fix.content).toContain('  deploy:\n    needs: [build]\n');
  });
});

describe('context resolution', () => {
  const tree = [
    '.github/workflows/ci.yml', 'services/api/package.json', 'services/api/src/utils/dates.ts', 'services/api/.npmrc',
    'services/worker/requirements.txt', 'services/worker/worker/jobs/cleanup.py', 'docs/src/utils/dates.ts', 'k8s/api.yaml', 'k8s/svc.yaml',
  ];
  const w = { path: '.github/workflows/ci.yml', content: MONOREPO_CI + '  deploy:\n    steps:\n      - run: kubectl apply -f k8s/\n' };

  it('resolves cwd-relative log paths inside job directories and fetches per-job manifests', () => {
    const logs = "src/utils/dates.ts(2,1): error TS1185: Merge conflict marker encountered.\nE   ModuleNotFoundError: No module named 'worker.cleanup'";
    const c = contextCandidates(tree, [w], categorizeAllErrors(logs).all, logs);
    expect(c).toContain('services/api/src/utils/dates.ts');
    expect(c).not.toContain('docs/src/utils/dates.ts');           // outside every job directory
    expect(c).toContain('services/worker/worker/jobs/cleanup.py'); // relocated module
    expect(c).toEqual(expect.arrayContaining(['services/api/package.json', 'services/api/.npmrc', 'services/worker/requirements.txt', 'k8s/api.yaml', 'k8s/svc.yaml']));
    expect(c.every(p => tree.includes(p))).toBe(true);             // nothing that would 404
  });
});

describe('diagnosis', () => {
  it('does not read "ModuleNotFoundError" as a network error, or ETARGET as a Node version problem', () => {
    expect(categorizeAllErrors("ModuleNotFoundError: No module named 'x'").all.map(d => d.category)).not.toContain('api_timeout');
    expect(categorizeAllErrors('npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for express@9.9.9.').all.map(d => d.category)).toEqual(['missing_dependency']);
    expect(categorizeAllErrors('9 vulnerabilities (3 low, 6 high)').primary.category).toBe('dependency_vulnerability');
  });
});
