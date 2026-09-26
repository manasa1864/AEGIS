// The healing ladder and its non-AI strategies: known-fix replay, compiler
// suggestions, exact versions, the auto-fixer CI job protocol, the AI partial-
// file guard, revert-to-last-green candidate selection, and the ladder order.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// localStorage for knownFixes (the test environment is Node)
const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

import { errorSignature, rememberFix, findKnownFix, markVerified } from '../src/app/lib/strategies/knownFixes';
import { fixCompilerSuggestions } from '../src/app/lib/fixers/code/source';
import { pinResolvedVersions, changesNpmDependencies } from '../src/app/lib/strategies/versions';
import { planAutofix, buildGithubWorkflow, buildGitlabCi, parseAutofixOutput } from '../src/app/lib/strategies/autofixJob';
import { looksTransient } from '../src/app/lib/strategies/flaky';
import { yamlParseError } from '../src/app/lib/yamlCheck';
import { b64EncodeUtf8 } from '../src/app/lib/base64';

const jsonResponse = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body, text: async () => JSON.stringify(body) });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => store.clear());

describe('1 · known-fix replay', () => {
  const logs1 = '2026-09-01T10:00:00.123Z Error: Cannot find module \'zod\' at /home/runner/work/app/app/src/a.js:3:7';
  const logs2 = '2026-09-26T08:12:44.001Z Error: Cannot find module \'zod\' at /home/runner/work/app/app/src/a.js:9:1';

  it('gives the same signature for the same error on different runs', () => {
    expect(errorSignature(logs1, ['missing_dependency'])).toBe(errorSignature(logs2, ['missing_dependency']));
    expect(errorSignature(logs1, ['missing_dependency'])).not.toBe(errorSignature("Error: Cannot find module 'axios'", ['missing_dependency']));
  });

  it('replays only while the files are still exactly as they were', () => {
    const sig = errorSignature(logs1, ['missing_dependency']);
    rememberFix('o/r', sig, [{ path: 'package.json', before: '{"a":1}', after: '{"a":1,"zod":"^3"}', explanation: 'add zod' }], false);
    markVerified('o/r', sig);
    const hit = findKnownFix('o/r', sig, [{ path: 'package.json', content: '{"a":1}', sha: 'abc' }]);
    expect(hit?.verified).toBe(true);
    expect(hit?.fixes[0]).toMatchObject({ path: 'package.json', content: '{"a":1,"zod":"^3"}', sha: 'abc' });
    expect(findKnownFix('o/r', sig, [{ path: 'package.json', content: '{"a":2}' }])).toBeNull();
  });
});

describe('2 · compiler "did you mean" suggestions', () => {
  it('TypeScript TS2551 at the reported column', () => {
    const [fix] = fixCompilerSuggestions(
      "src/u.ts(2,15): error TS2551: Property 'nmae' does not exist on type 'User'. Did you mean 'name'?",
      [{ path: 'src/u.ts', content: 'const nmae = 1;\nconsole.log(u.nmae, nmae);\n' }],
    );
    expect(fix.content).toBe('const nmae = 1;\nconsole.log(u.name, nmae);\n');
  });

  it('Python NameError, located by the traceback frame', () => {
    const [fix] = fixCompilerSuggestions(
      'Traceback (most recent call last):\n  File "/home/runner/work/r/r/app/calc.py", line 3, in total\n    return lenght * 2\nNameError: name \'lenght\' is not defined. Did you mean: \'length\'?',
      [{ path: 'app/calc.py', content: 'def total(length):\n    x = 1\n    return lenght * 2\n' }],
    );
    expect(fix.content).toBe('def total(length):\n    x = 1\n    return length * 2\n');
  });

  it("rustc's similar-name help", () => {
    const log = [
      'error[E0425]: cannot find value `conut` in this scope',
      ' --> src/main.rs:3:20',
      '  |',
      '3 |     println!("{}", conut);',
      '  |                    ^^^^^ help: a local variable with a similar name exists: `count`',
    ].join('\n');
    const [fix] = fixCompilerSuggestions(log, [{ path: 'src/main.rs', content: 'fn main() {\n    let count = 1;\n    println!("{}", conut);\n}\n' }]);
    expect(fix.content).toContain('println!("{}", count);');
  });
});

describe('exact dependency versions', () => {
  it('replaces "latest" with the registry version and flags the lockfile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('registry.npmjs.org/zod') ? jsonResponse({ version: '3.23.8' }) : jsonResponse({}, false))));
    const orig = [{ path: 'package.json', content: '{\n  "dependencies": {}\n}\n' }];
    const fixes = [{ path: 'package.json', content: '{\n  "dependencies": {\n    "zod": "latest"\n  }\n}\n', explanation: 'x' }];
    const out = await pinResolvedVersions(fixes, orig);
    expect(JSON.parse(out.fixes[0].content).dependencies.zod).toBe('^3.23.8');
    expect(out.pinned).toEqual(['zod@^3.23.8']);
    expect(changesNpmDependencies(out.fixes, orig)).toBe(true);
  });

  it('pins only the requirements lines a fix added', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('pypi.org/pypi/PyYAML') ? jsonResponse({ info: { version: '6.0.2' } }) : jsonResponse({}, false))));
    const out = await pinResolvedVersions(
      [{ path: 'requirements.txt', content: 'requests\nPyYAML\n', explanation: 'x' }],
      [{ path: 'requirements.txt', content: 'requests\n' }],
    );
    expect(out.fixes[0].content).toBe('requests\nPyYAML==6.0.2\n');
  });
});

describe('4 · auto-fixer CI job', () => {
  it('only runs tools the repo already uses', () => {
    expect(planAutofix([{ path: 'README.md', content: '' }], 'full')).toBeNull();
    const plan = planAutofix([
      { path: 'package.json', content: '{"devDependencies":{"eslint":"9"}}' },
      { path: 'yarn.lock', content: '' },
    ], 'full')!;
    expect(plan.node).toEqual({ pm: 'yarn', eslint: true, prettier: false });
    expect(plan.python).toBeUndefined();
  });

  it('generates valid GitHub and GitLab job files', () => {
    const plan = planAutofix([
      { path: 'package.json', content: '{"devDependencies":{"prettier":"3"}}' },
      { path: 'pyproject.toml', content: '[tool.ruff]\n' },
      { path: 'Cargo.toml', content: '[package]' },
    ], 'full')!;
    expect(yamlParseError('.github/workflows/aegis-autofix.yml', buildGithubWorkflow(plan))).toBeNull();
    expect(yamlParseError('.gitlab-ci.yml', buildGitlabCi(plan))).toBeNull();
    expect(buildGithubWorkflow(plan)).toContain('contents: read'); // the job never pushes
  });

  it('reassembles changed files from the job log (chunks, ANSI codes, odd paths)', () => {
    const content = 'x'.repeat(40) + '\nünïcode ✓\n';
    const b64 = b64EncodeUtf8(content);
    const path = b64EncodeUtf8('src/with space.ts');
    const log = [
      '$ echo "AEGIS_B64 $p $chunk"',                        // echoed command — must be ignored
      `\u001b[0KAEGIS_B64 ${path} ${b64.slice(0, 20)}`,
      `AEGIS_B64 ${path} ${b64.slice(20)}\r`,
      'AEGIS_RAN eslint --fix',
      'AEGIS_CHANGED_END',
    ].join('\n');
    const out = parseAutofixOutput(log);
    expect(out.files.get('src/with space.ts')).toBe(content);
    expect(out.tools).toEqual(['eslint --fix']);
  });
});

describe('3 · flaky check triggers', () => {
  it('runs first only when every diagnosed cause is transient', () => {
    expect(looksTransient(['api_timeout', 'runner_unavailable'])).toBe(true);
    expect(looksTransient(['api_timeout', 'lint_failure'])).toBe(false);
    expect(looksTransient([])).toBe(false);
  });
});

describe('5 · AI partial-file guard (Groq)', () => {
  it('refuses rewrites of files the model only saw truncated', async () => {
    const { analyzeAndFixWithGroq } = await import('../src/app/lib/groq');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        analysis: 'a', confidence: 90,
        fixes: [
          { path: 'src/big.ts', content: 'export const x = 1;\n', explanation: 'rewrite big' },
          { path: 'src/small.ts', content: 'export const y = 2;\n', explanation: 'fix small' },
        ],
      }) } }],
    })));
    const r = await analyzeAndFixWithGroq('k', 'ctx', [
      { path: 'src/big.ts', content: '// big\n'.repeat(1000) },
      { path: 'src/small.ts', content: 'export const y = 1;\n' },
    ]);
    expect(r!.fixes.map(f => f.path)).toEqual(['src/small.ts']);
    expect(r!.refusedPartial).toEqual(['src/big.ts']);
  });
});

describe('6 · revert to last green', () => {
  it('prefers the newest single-commit revert that goes green, skips overlapping commits, cleans up', async () => {
    vi.resetModules();
    const deleted: string[] = [];
    const created: Array<{ branch: string; paths: string[] }> = [];
    vi.doMock('../src/app/lib/github', () => ({
      getBranchSha: async () => 'bad0000',
      getLastGreenRun: async () => ({ head_sha: 'good000' }),
      compareCommits: async () => ({
        commits: [ // oldest → newest, as GitHub returns them
          { sha: 'c1aaaaa', message: 'feat: A', parent: 'good000' },
          { sha: 'c2bbbbb', message: 'feat: B', parent: 'c1aaaaa' },
          { sha: 'c3ccccc', message: 'refactor: C', parent: 'c2bbbbb' },
        ],
        files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'modified' }],
      }),
      getCommitFiles: async (_p: string, _o: string, _r: string, sha: string) =>
        sha === 'c3ccccc' ? [{ path: 'b.ts', status: 'modified' }]
          : sha === 'c2bbbbb' ? [{ path: 'b.ts', status: 'modified' }] // overlaps c3 → cannot be restored alone
            : [{ path: 'a.ts', status: 'added' }],
      getTreeEntries: async () => new Map([['a.ts', { path: 'a.ts', mode: '100644', sha: 'blobA', type: 'blob' }], ['b.ts', { path: 'b.ts', mode: '100644', sha: 'blobB', type: 'blob' }]]),
      createBranchWithCommit: async (_p: string, _o: string, _r: string, branch: string, _parent: string, changes: Array<{ path: string }>) => {
        created.push({ branch, paths: changes.map(c => c.path) });
        return 'newsha';
      },
      waitForBranchCI: async (_p: string, _o: string, _r: string, branch: string) => (branch.endsWith('-1') ? 'success' : 'failure'),
      deleteBranch: async (_p: string, _o: string, _r: string, branch: string) => { deleted.push(branch); return true; },
      createPR: async () => 'https://github.com/o/r/pull/9',
    }));
    const { revertToLastGreen } = await import('../src/app/lib/strategies/revert');
    const result = await revertToLastGreen({
      platform: 'github', pat: 'p', owner: 'o', repo: 'r', branch: 'main',
      failingRuns: [{ id: 1, name: 'CI', headSha: 'bad0000', workflowId: 7 }],
      log: () => {}, isCancelled: () => false,
    }, 1000);
    // candidates: revert c3 (newest), c2 skipped (overlaps c3), revert c1, then the whole range
    expect(created.map(c => c.paths)).toEqual([['b.ts'], ['a.ts'], ['a.ts', 'b.ts']]);
    expect(result).toMatchObject({ status: 'reverted', prUrl: 'https://github.com/o/r/pull/9', label: 'revert c3ccccc', verified: true });
    expect(deleted).toHaveLength(2); // the losing candidates
    vi.doUnmock('../src/app/lib/github');
  });
});

describe('the ladder order', () => {
  it('tries known fix → rules → flaky → auto-fixers → AI → revert, stopping at the first success', async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock('../src/app/lib/strategies/flaky', async (orig) => ({
      ...(await orig<object>()),
      checkFlaky: async () => { calls.push('flaky'); return 'still-failing'; },
    }));
    vi.doMock('../src/app/lib/strategies/autofixJob', async (orig) => ({
      ...(await orig<object>()),
      runAutofixJob: async () => { calls.push('autofix'); return { status: 'no-changes', changed: [], tools: ['eslint --fix'] }; },
    }));
    vi.doMock('../src/app/lib/strategies/revert', () => ({
      revertToLastGreen: async () => { calls.push('revert'); return { status: 'reverted', prUrl: 'u', label: 'revert abc', verified: true }; },
    }));
    const { runHealingLadder } = await import('../src/app/lib/strategies/ladder');
    const marks: string[] = [];
    const result = await runHealingLadder({
      ctx: { platform: 'github', pat: 'p', owner: 'o', repo: 'r', branch: 'main', failingRuns: [{ id: 1, name: 'CI' }], log: () => {}, isCancelled: () => false },
      repoKey: 'o/r', signature: 'sig', logs: 'something odd happened', categories: ['unknown'], diagnoses: [],
      files: [{ path: 'README.md', content: 'x' }], errorContext: '', keys: { gemini: '', groq: '', gcloud: '' },
      approvalThreshold: 65, requestApproval: async () => true,
      onStrategy: (id, state) => marks.push(`${id}:${state}`),
    });
    expect(calls).toEqual(['flaky', 'autofix', 'revert']);
    expect(marks).toEqual([
      'memory:active', 'memory:skipped', 'rules:active', 'rules:failed', 'flaky:active', 'flaky:failed',
      'autofix:active', 'autofix:failed', 'ai:skipped', 'revert:active', 'revert:done',
    ]);
    expect(result).toMatchObject({ kind: 'reverted', prUrl: 'u' });
    vi.doUnmock('../src/app/lib/strategies/flaky');
    vi.doUnmock('../src/app/lib/strategies/autofixJob');
    vi.doUnmock('../src/app/lib/strategies/revert');
  });

  it('checks flakiness BEFORE changing code when every cause is transient — and stops if it passes', async () => {
    vi.resetModules();
    vi.doMock('../src/app/lib/strategies/flaky', async (orig) => ({ ...(await orig<object>()), checkFlaky: async () => 'flaky' }));
    const { runHealingLadder } = await import('../src/app/lib/strategies/ladder');
    const marks: string[] = [];
    const result = await runHealingLadder({
      ctx: { platform: 'github', pat: 'p', owner: 'o', repo: 'r', branch: 'main', failingRuns: [{ id: 1, name: 'CI' }], log: () => {}, isCancelled: () => false },
      repoKey: 'o/r', signature: 'sig2', logs: 'Error: connect ETIMEDOUT 10.0.0.1:443', categories: ['api_timeout'], diagnoses: [],
      files: [], errorContext: '', keys: { gemini: '', groq: '', gcloud: '' },
      approvalThreshold: 65, requestApproval: async () => true, onStrategy: (id, state) => marks.push(`${id}:${state}`),
    });
    expect(result.kind).toBe('flaky');
    expect(marks).toEqual(['memory:active', 'memory:skipped', 'flaky:active', 'flaky:done']); // rules never ran
    vi.doUnmock('../src/app/lib/strategies/flaky');
  });
});
