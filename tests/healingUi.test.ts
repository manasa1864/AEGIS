// Code-level fixers, the unified-diff writer, the live healing-run state
// machine that drives the dashboard, and the YAML safety guards.

import { describe, it, expect } from 'vitest';
import {
  fixUnusedImports, fixPythonUnusedImports, fixNullDerefAtStackFrame, fixFocusedTests,
  fixMissingNpmPackage, extractLogFileRefs,
} from '../src/app/lib/fixers/code/source';
import { unifiedDiff, diffLines, diffStats } from '../src/app/lib/lineDiff';
import {
  startRun, applyStreamMessage, withFixes, withOutcome, inferOutcome, nodeStatusFor, type HealingRun,
} from '../src/app/lib/healingRun';
import { validateFix } from '../src/app/lib/fixValidator';
import { applyRuleBasedFixes } from '../src/app/lib/ruleBasedFixer';
import { fixStepUsesAndRun, fixDuplicateYamlKey, fixYamlTabIndentation } from '../src/app/lib/fixers/simple/syntax';
import { yamlParseError } from '../src/app/lib/yamlCheck';

describe('code-level fixers', () => {
  it('extracts repo-relative source locations from runner paths', () => {
    const refs = extractLogFileRefs('    at f (/home/runner/work/app/app/src/a.js:3:22)\nsrc/b.ts(4,2): error TS2578: x');
    expect(refs).toEqual(expect.arrayContaining([
      { path: 'src/a.js', line: 3, col: 22 },
      { path: 'src/b.ts', line: 4, col: 2 },
    ]));
  });

  it('removes only the unused specifier from a TS import', () => {
    const [fix] = fixUnusedImports(
      "src/s.ts(1,10): error TS6133: 'readFile' is declared but its value is never read.",
      [{ path: 'src/s.ts', content: "import { readFile, writeFile } from 'node:fs/promises';\nawait writeFile('a', 'b');\n" }],
    );
    expect(fix.content).toBe("import { writeFile } from 'node:fs/promises';\nawait writeFile('a', 'b');\n");
  });

  it('never touches unused local variables (possible side effects)', () => {
    const fixes = fixUnusedImports(
      "src/s.ts(2,7): error TS6133: 'x' is declared but its value is never read.",
      [{ path: 'src/s.ts', content: "import a from 'a';\nconst x = sideEffect();\n" }],
    );
    expect(fixes).toEqual([]);
  });

  it('handles Python aliased imports reported by flake8', () => {
    const [fix] = fixPythonUnusedImports(
      "app/m.py:1:1: F401 'numpy as np' imported but unused",
      [{ path: 'app/m.py', content: 'import numpy as np, os\nprint(os.name)\n' }],
    );
    expect(fix.content).toBe('import os\nprint(os.name)\n');
  });

  it('guards only the property access at the crashing frame', () => {
    const [fix] = fixNullDerefAtStackFrame(
      "TypeError: Cannot read properties of undefined (reading 'email')\n    at f (/home/runner/work/r/r/src/u.js:2:15)",
      [{ path: 'src/u.js', content: 'const a = user.email;\nreturn user.profile.email;\n' }],
    );
    expect(fix.content).toBe('const a = user.email;\nreturn user.profile?.email;\n');
  });

  it('removes .only from focused tests', () => {
    const [fix] = fixFocusedTests('Error: Unexpected .only modifier.', [{ path: 'src/a.test.ts', content: "it.only('x', () => {});\n" }]);
    expect(fix.content).toBe("it('x', () => {});\n");
  });

  it('declares a missing package but ignores relative imports and node builtins', () => {
    const logs = "Cannot find package 'zod' imported from x\nCannot find module './local'\nCannot find module 'node:fs'\nCannot find module 'fs'";
    const [fix] = fixMissingNpmPackage(logs, [{ path: 'package.json', content: '{\n  "name": "a",\n  "dependencies": {}\n}\n' }]);
    expect(JSON.parse(fix.content).dependencies).toEqual({ zod: 'latest' });
  });
});

describe('YAML safety', () => {
  it('the validator blocks a fix that turns valid YAML invalid', () => {
    const r = validateFix({ path: 'a.yml', content: 'a:\n  b: 1\n   c: 2\n', explanation: '' }, 'a:\n  b: 1\n');
    expect(r.safe).toBe(false);
  });

  it('splits a uses+run step into two steps instead of discarding the command', () => {
    const [fix] = fixStepUsesAndRun([{ path: '.github/workflows/ci.yml', content: 'jobs:\n  b:\n    steps:\n      - uses: actions/setup-node@v4\n        run: npm ci\n' }]);
    expect(fix.content).toBe('jobs:\n  b:\n    steps:\n      - uses: actions/setup-node@v4\n      - run: npm ci\n');
  });

  it('detects duplicate keys inside nested mappings, but not across YAML documents', () => {
    const nested = fixDuplicateYamlKey([{ path: 'a.yml', content: 'jobs:\n  b:\n    runs-on: x\n    runs-on: y\n' }]);
    expect(nested).toHaveLength(1);
    const multiDoc = fixDuplicateYamlKey([{ path: 'k8s.yaml', content: 'kind: A\nmetadata:\n  name: a\n---\nkind: B\nmetadata:\n  name: b\n' }]);
    expect(multiDoc).toEqual([]);
  });

  it('a tab under a block-opening key becomes a child, not a sibling', () => {
    const [fix] = fixYamlTabIndentation([{ path: 'a.yml', content: 'jobs:\n  build:\n\truns-on: x\n' }]);
    expect(fix.content).toBe('jobs:\n  build:\n    runs-on: x\n');
  });

  it('the orchestrator never emits unparseable YAML for a standard workflow', () => {
    const wf = 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n';
    for (const cat of ['deploy_failure', 'docker_build', 'go_build_failure', 'rust_build_failure', 'git_lfs_error'] as const) {
      for (const f of applyRuleBasedFixes(cat, 'Error: Process completed with exit code 1.', [{ path: '.github/workflows/ci.yml', content: wf }])) {
        expect(yamlParseError(f.path, f.content), `${cat}: ${f.path}`).toBeNull();
      }
    }
  }, 20_000); // 5 full engine runs — generous budget for a loaded CI runner
});

describe('unified diff', () => {
  it('writes a new-file diff', () => {
    const d = unifiedDiff('a.txt', null, 'x\ny\n');
    expect(d).toContain('new file mode 100644');
    expect(d).toContain('--- /dev/null');
    expect(d).toContain('@@ -0,0 +1,2 @@\n+x\n+y\n');
  });

  it('marks a missing final newline the way git expects', () => {
    const d = unifiedDiff('a.txt', 'x\n', 'x');
    expect(d).toContain('-x\n+x\n\\ No newline at end of file\n');
  });

  it('counts additions and deletions', () => {
    expect(diffStats(diffLines('a\nb\n', 'a\nc\nd\n'))).toEqual({ added: 2, removed: 1 });
  });
});

describe('live healing run (drives the dashboard UI)', () => {
  const feed = (run: HealingRun, ...msgs: string[]) => msgs.reduce((r, m) => applyStreamMessage(r, m), run);

  it('advances phases from the stream and keeps finished phases lit', () => {
    let r = startRun();
    r = feed(r, 'fetching_workflow_runs :: status=failure', 'ci_failure :: workflows=1 [CI] commit=abc', '#2 :: strategy=ai_analysis model=x', 'ERROR_DIAGNOSED :: categories=[yaml_syntax]');
    expect(r.phases.detect).toBe('done');
    expect(r.phases.analyze).toBe('done');
    expect(r.phases.diagnose).toBe('done');
    expect(r.phases.fix).toBe('active');
    expect(nodeStatusFor(r, 'fix-engine')).toBe('processing');
    expect(nodeStatusFor(r, 'code-push')).toBe('success');
  });

  it('tracks each fix from proposed to committed and records the PR', () => {
    let r = withFixes(startRun(), [{ path: 'ci.yml', content: 'new', explanation: 'e' }], [{ path: 'ci.yml', content: 'old' }], 'rule');
    r = feed(r, '#3 :: strategy=create_branch name=aegis/fix-1', '#4 :: strategy=commit_fix path=ci.yml');
    expect(r.fixes[0].status).toBe('committing');
    expect(r.branch).toBe('aegis/fix-1');
    r = feed(r, 'fix_committed :: sha=abc1234 path=ci.yml');
    r = applyStreamMessage(r, 'PR_CREATED :: confidence=90%', 'https://github.com/o/r/pull/1');
    r = feed(r, 'VERIFY_FIX :: polling_ci', 'FIX_VERIFIED :: ci_green');
    expect(r.fixes[0]).toMatchObject({ status: 'committed', before: 'old', after: 'new' });
    expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(r.verify).toBe('success');
    const o = inferOutcome(r, '');
    expect(o.kind).toBe('healed');
    expect(nodeStatusFor(withOutcome(r, o.kind, o.reason), 'pipeline')).toBe('success');
  });

  it('reports the real reason when a run halts', () => {
    const r = feed(startRun(), 'fetching_workflow_runs :: status=failure');
    const o = inferOutcome(r, 'HALT_EXECUTION :: no_fixes_available manual_intervention_required');
    expect(o.kind).toBe('halted');
    expect(o.reason).toContain('no fixes available');
    const done = withOutcome(r, o.kind, o.reason);
    expect(done.phases.detect).toBe('failed');
    expect(done.phases.verify).toBe('skipped');
  });
});
