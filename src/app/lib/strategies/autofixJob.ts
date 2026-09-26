// Strategy 4 — run the project's OWN fixers in CI (eslint --fix, prettier,
// ruff/black/isort, gofmt, cargo clippy --fix, dotnet format, lockfile refresh).
//
// Aegis cannot execute code in the browser, so it pushes a short-lived branch
// containing only a tiny CI job. The job runs the tools with the repo's own
// config and prints every file it changed (base64) into its log. Aegis reads
// the log, deletes the branch, and routes the changed files through the same
// validator as any other fix. The job never commits or pushes anything itself
// (`contents: read`), so nothing from it is ever merged by accident.

import {
  createBranch as ghCreateBranch, commitFile as ghCommitFile, deleteBranch as ghDeleteBranch,
  findRunOnBranch, waitForRun, getRunJobs, getJobLogsFull as ghJobLogs,
} from '../github';
import {
  createBranch as glCreateBranch, commitFile as glCommitFile, deleteBranch as glDeleteBranch,
  getBranchHead, getPipelineForSha, waitForPipeline, getPipelineJobs, getJobLogsFull as glJobLogs,
} from '../gitlab';
import { b64DecodeUtf8 } from '../base64';
import type { RepoFile, StrategyContext } from './types';

export const AUTOFIX_WORKFLOW_PATH = '.github/workflows/aegis-autofix.yml';
const WORKFLOW_NAME = 'Aegis Autofix';

export interface AutofixPlan {
  node?: { pm: 'npm' | 'pnpm' | 'yarn'; eslint: boolean; prettier: boolean };
  python?: { ruff: boolean; ruffFormat: boolean; black: boolean; isort: boolean };
  go: boolean;
  rust: boolean;
  dotnet: boolean;
  mode: 'full' | 'lockfile';
}

/** Which of the project's own tools to run — only tools the repo already uses
 *  (config file, dependency, or invoked by its CI). Never introduces a new
 *  formatter, which would reformat the whole codebase. */
export function planAutofix(files: RepoFile[], mode: 'full' | 'lockfile'): AutofixPlan | null {
  const has = (re: RegExp) => files.some(f => re.test(f.path));
  const ci = files.filter(f => /\.github\/workflows\/|\.gitlab-ci/.test(f.path)).map(f => f.content).join('\n');
  const pkgText = files.find(f => f.path === 'package.json')?.content ?? '';
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try { pkg = JSON.parse(pkgText || '{}'); } catch { /* keep empty */ }
  const dep = (n: string) => !!(pkg.dependencies?.[n] || pkg.devDependencies?.[n]);
  const pyText = files.filter(f => /(^|\/)(pyproject\.toml|setup\.cfg|requirements[^/]*\.txt|ruff\.toml|\.ruff\.toml)$/.test(f.path)).map(f => f.content).join('\n');

  const plan: AutofixPlan = { go: false, rust: false, dotnet: false, mode };

  if (pkgText) {
    const pm = has(/(^|\/)pnpm-lock\.yaml$/) ? 'pnpm' : has(/(^|\/)yarn\.lock$/) ? 'yarn' : 'npm';
    plan.node = {
      pm,
      eslint: mode === 'full' && (dep('eslint') || has(/(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/)),
      prettier: mode === 'full' && (dep('prettier') || has(/(^|\/)(\.prettierrc(\.\w+)?|prettier\.config\.[cm]?js)$/)),
    };
  }
  if (mode === 'full') {
    if (pyText || /\b(ruff|black|isort|flake8)\b/.test(ci)) {
      const ruff = /\bruff\b/.test(pyText + ci);
      plan.python = {
        ruff,
        ruffFormat: ruff && /ruff format|\[tool\.ruff\.format\]/.test(pyText + ci),
        black: /\bblack\b/.test(pyText + ci),
        isort: /\bisort\b/.test(pyText + ci),
      };
      if (!plan.python.ruff && !plan.python.black && !plan.python.isort) delete plan.python;
    }
    plan.go = has(/(^|\/)go\.mod$/);
    plan.rust = has(/(^|\/)Cargo\.toml$/);
    plan.dotnet = /\bdotnet (build|test|format)\b/.test(ci) || has(/\.(csproj|sln)$/);
  }

  const anything = (plan.node && (mode === 'lockfile' || plan.node.eslint || plan.node.prettier)) || plan.python || plan.go || plan.rust || plan.dotnet;
  return anything ? plan : null;
}

// ── job script ────────────────────────────────────────────────────────────────

function nodeScript(n: NonNullable<AutofixPlan['node']>, mode: AutofixPlan['mode']): string[] {
  const install = {
    npm: mode === 'lockfile' ? 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund' : 'npm install --ignore-scripts --no-audit --no-fund',
    pnpm: mode === 'lockfile' ? 'pnpm install --lockfile-only --ignore-scripts' : 'pnpm install --ignore-scripts --no-frozen-lockfile',
    yarn: 'yarn install --ignore-scripts',
  }[n.pm];
  const lines = [
    'corepack enable >/dev/null 2>&1 || true',
    `${install} && echo "AEGIS_RAN ${n.pm} install (lockfile refresh)"`,
  ];
  if (n.eslint) lines.push('if [ -x node_modules/.bin/eslint ]; then node_modules/.bin/eslint . --fix; echo "AEGIS_RAN eslint --fix"; fi');
  if (n.prettier) lines.push('if [ -x node_modules/.bin/prettier ]; then node_modules/.bin/prettier --write . >/dev/null; echo "AEGIS_RAN prettier --write"; fi');
  return lines;
}

function pythonScript(p: NonNullable<AutofixPlan['python']>): string[] {
  const pkgs = [p.ruff && 'ruff', p.black && 'black', p.isort && 'isort'].filter(Boolean).join(' ');
  const lines = [`python -m pip install --quiet ${pkgs}`];
  if (p.ruff) lines.push('ruff check --fix . ; echo "AEGIS_RAN ruff check --fix"');
  if (p.ruffFormat) lines.push('ruff format . ; echo "AEGIS_RAN ruff format"');
  if (p.isort) lines.push('isort . ; echo "AEGIS_RAN isort"');
  if (p.black) lines.push('black . ; echo "AEGIS_RAN black"');
  return lines;
}

/** Prints every changed/new file as base64 chunks the dashboard reassembles. */
export const REPORT_SCRIPT = [
  'git config --global --add safe.directory "$PWD" 2>/dev/null || true',
  "{ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u \\",
  "  | grep -v -E '^(\\.github/workflows/aegis-autofix\\.yml|\\.gitlab-ci\\.yml)$' \\",
  "  | grep -v -E '(^|/)(node_modules|\\.venv|venv|target|dist|build|__pycache__)/' | head -n 60 > /tmp/aegis_changed || true",
  'echo "AEGIS_CHANGED_BEGIN"',
  'while IFS= read -r f; do',
  '  [ -f "$f" ] || continue',
  '  [ "$(wc -c < "$f")" -le 2000000 ] || continue',
  "  p=$(printf '%s' \"$f\" | base64 -w0)",
  '  base64 -w 16000 "$f" | while IFS= read -r chunk; do echo "AEGIS_B64 $p $chunk"; done',
  'done < /tmp/aegis_changed',
  'echo "AEGIS_CHANGED_END"',
];

function scriptFor(plan: AutofixPlan, stack: 'node' | 'python' | 'go' | 'rust' | 'dotnet'): string[] {
  const body =
    stack === 'node' ? nodeScript(plan.node!, plan.mode)
    : stack === 'python' ? pythonScript(plan.python!)
    : stack === 'go' ? ['gofmt -w . && echo "AEGIS_RAN gofmt"', 'go mod tidy && echo "AEGIS_RAN go mod tidy"']
    : stack === 'rust' ? ['cargo fmt --all && echo "AEGIS_RAN cargo fmt"', 'cargo clippy --fix --allow-dirty --allow-no-vcs --all-targets -q && echo "AEGIS_RAN cargo clippy --fix"']
    : ['dotnet format && echo "AEGIS_RAN dotnet format"'];
  return ['set +e', ...body, ...REPORT_SCRIPT];
}

const stacksOf = (plan: AutofixPlan) =>
  (['node', 'python', 'go', 'rust', 'dotnet'] as const).filter(s => (s === 'node' ? !!plan.node : s === 'python' ? !!plan.python : plan[s]));

const indent = (lines: string[], n: number) => lines.map(l => ' '.repeat(n) + l).join('\n');

export function buildGithubWorkflow(plan: AutofixPlan): string {
  const setup: Record<string, string> = {
    node: '      - uses: actions/setup-node@v4\n        with:\n          node-version: 22',
    python: "      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'",
    go: '      - uses: actions/setup-go@v5\n        with:\n          go-version: stable',
    rust: '      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: rustfmt, clippy',
    dotnet: '      - uses: actions/setup-dotnet@v4\n        with:\n          dotnet-version: 8.x',
  };
  const jobs = stacksOf(plan).map(stack => [
    `  ${stack}:`,
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 15',
    '    steps:',
    '      - uses: actions/checkout@v4',
    setup[stack],
    `      - name: Run the project's own ${stack} fixers`,
    '        shell: bash',
    '        run: |',
    indent(scriptFor(plan, stack), 10),
  ].join('\n'));
  return [
    `name: ${WORKFLOW_NAME}`,
    '# Temporary: pushed by Aegis on a throwaway branch, which is deleted afterwards.',
    'on:',
    '  push:',
    "    branches: ['aegis/autofix-*']",
    'permissions:',
    '  contents: read',
    'jobs:',
    jobs.join('\n\n'),
    '',
  ].join('\n');
}

export function buildGitlabCi(plan: AutofixPlan): string {
  const image: Record<string, string> = { node: 'node:22', python: 'python:3.12', go: 'golang:1.22', rust: 'rust:1', dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0' };
  const jobs = stacksOf(plan).map(stack => [
    `aegis-${stack}:`,
    '  stage: autofix',
    `  image: ${image[stack]}`,
    ...(stack === 'rust' ? ['  before_script:', '    - rustup component add rustfmt clippy'] : []),
    '  script:',
    '    - |',
    indent(scriptFor(plan, stack), 6),
  ].join('\n'));
  return ['# Temporary: pushed by Aegis on a throwaway branch, which is deleted afterwards.', 'stages: [autofix]', '', jobs.join('\n\n'), ''].join('\n');
}

// ── output parsing ────────────────────────────────────────────────────────────

export function parseAutofixOutput(log: string): { files: Map<string, string>; tools: string[] } {
  const chunks = new Map<string, string[]>();
  const tools: string[] = [];
  for (const raw of log.split('\n')) {
    // GitLab traces contain ANSI colour codes — strip them before matching
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
    const b = line.match(/^AEGIS_B64 ([A-Za-z0-9+/=]+) ([A-Za-z0-9+/=]+)$/);
    if (b) {
      if (!chunks.has(b[1])) chunks.set(b[1], []);
      chunks.get(b[1])!.push(b[2]);
      continue;
    }
    const t = line.match(/^AEGIS_RAN (.+)$/);
    if (t && !tools.includes(t[1])) tools.push(t[1]);
  }
  const files = new Map<string, string>();
  for (const [p64, parts] of chunks) {
    try {
      const content = b64DecodeUtf8(parts.join(''));
      if (content.includes('\u0000')) continue; // binary — not something to commit through the contents API
      files.set(b64DecodeUtf8(p64), content);
    } catch { /* malformed chunk */ }
  }
  return { files, tools };
}

// ── running it ────────────────────────────────────────────────────────────────

export interface AutofixResult {
  status: 'ok' | 'no-changes' | 'no-tools' | 'unavailable' | 'timeout' | 'failed';
  changed: Array<{ path: string; content: string }>;
  tools: string[];
  note?: string;
}

export async function runAutofixJob(
  ctx: StrategyContext, baseRef: string, repoFiles: RepoFile[], mode: 'full' | 'lockfile', maxWaitMs = 12 * 60_000,
): Promise<AutofixResult> {
  const plan = planAutofix(repoFiles, mode);
  if (!plan) return { status: 'no-tools', changed: [], tools: [] };
  const temp = `aegis/autofix-${Date.now()}`;
  const { pat, owner, repo } = ctx;
  const gh = ctx.platform === 'github';

  const created = gh ? await ghCreateBranch(pat, owner, repo, temp, baseRef) : await glCreateBranch(pat, owner, repo, temp, baseRef);
  if (!created) return { status: 'unavailable', changed: [], tools: [], note: 'could not create a temporary branch' };

  try {
    let log = '';
    if (gh) {
      const committed = await ghCommitFile(pat, owner, repo, AUTOFIX_WORKFLOW_PATH, buildGithubWorkflow(plan), '', 'chore(aegis): temporary autofix job', temp);
      if (!committed) return { status: 'unavailable', changed: [], tools: [], note: 'could not push the job — the token needs the "workflow" scope' };
      let run = null;
      for (let i = 0; i < 12 && !run && !ctx.isCancelled(); i++) {
        await new Promise(r => setTimeout(r, 10_000));
        run = await findRunOnBranch(pat, owner, repo, temp, WORKFLOW_NAME);
      }
      if (!run) return { status: 'unavailable', changed: [], tools: [], note: 'the job never started — are GitHub Actions enabled?' };
      const outcome = await waitForRun(pat, owner, repo, run.id, maxWaitMs, 15_000, ctx.isCancelled);
      if (outcome === 'timeout') return { status: 'timeout', changed: [], tools: [] };
      const jobs = await getRunJobs(pat, owner, repo, run.id);
      log = (await Promise.all(jobs.map(j => ghJobLogs(pat, owner, repo, j.id)))).join('\n');
    } else {
      const committed = await glCommitFile(pat, owner, repo, '.gitlab-ci.yml', buildGitlabCi(plan), 'chore(aegis): temporary autofix job', temp);
      if (!committed) return { status: 'unavailable', changed: [], tools: [], note: 'could not push the job' };
      const sha = await getBranchHead(pat, owner, repo, temp);
      let pipeline = null;
      for (let i = 0; i < 12 && !pipeline && sha && !ctx.isCancelled(); i++) {
        await new Promise(r => setTimeout(r, 10_000));
        pipeline = await getPipelineForSha(pat, owner, repo, temp, sha);
      }
      if (!pipeline) return { status: 'unavailable', changed: [], tools: [], note: 'the job never started — is a runner available?' };
      const outcome = await waitForPipeline(pat, owner, repo, pipeline.id, maxWaitMs, 15_000, ctx.isCancelled);
      if (outcome === 'timeout') return { status: 'timeout', changed: [], tools: [] };
      const jobs = await getPipelineJobs(pat, owner, repo, pipeline.id);
      log = (await Promise.all(jobs.map(j => glJobLogs(pat, owner, repo, j.id)))).join('\n');
    }

    if (!log.includes('AEGIS_CHANGED_END')) return { status: 'failed', changed: [], tools: [], note: 'job did not finish its report (see the job log)' };
    const { files, tools } = parseAutofixOutput(log);
    const changed = [...files].map(([path, content]) => ({ path, content }));
    return { status: changed.length ? 'ok' : 'no-changes', changed, tools };
  } finally {
    if (gh) await ghDeleteBranch(pat, owner, repo, temp);
    else await glDeleteBranch(pat, owner, repo, temp);
  }
}
