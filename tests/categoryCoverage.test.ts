// Category coverage — enforces the README's central claim: every declared
// error category is diagnosable and has a crash-free fixer path.
//
// This test exists because an earlier audit found 8 fixer implementations that
// were imported but never wired into the orchestrator, and 3 categories that
// worked in code but were missing from the README table. Locking coverage in
// a test means the category list, the pattern table, and the docs can't
// silently drift apart again.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAGNOSIS_PATTERNS, categorizeAllErrors } from '../src/app/lib/diagnostics';
import type { ErrorCategory } from '../src/app/lib/diagnostics';
import { applyRuleBasedFixes } from '../src/app/lib/ruleBasedFixer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the ErrorCategory union straight out of the source file so the test
 *  sees every declared category, not just the ones somebody remembered. */
function declaredCategories(): string[] {
  const src = readFileSync(join(ROOT, 'src/app/lib/diagnostics.ts'), 'utf8');
  const m = src.match(/export type ErrorCategory =\n([\s\S]*?)\n\nexport interface/);
  if (!m) throw new Error('Could not locate ErrorCategory union in diagnostics.ts');
  return [...m[1].matchAll(/^\s*\|\s*'([a-z0-9_]+)'/gm)].map(x => x[1]);
}

/** Parse the category rows out of the README table. */
function readmeCategories(): string[] {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8');
  return [...md.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map(x => x[1]);
}

const REPRESENTATIVE_FILES = [
  { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v3\n      - run: npm ci && npm test\n' },
  { path: '.gitlab-ci.yml', content: 'stages: [test]\ntest:\n  stage: test\n  script: [npm test]\n' },
  { path: 'package.json', content: '{"name":"x","version":"1.0.0","scripts":{"test":"jest"},"dependencies":{}}' },
  { path: 'Dockerfile', content: 'FROM node:18\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD ["node","index.js"]\n' },
];

describe('category coverage — declared vs diagnosable', () => {
  const declared = declaredCategories();

  it('declares a meaningful number of categories', () => {
    expect(declared.length).toBeGreaterThanOrEqual(116);
  });

  it("every declared category except 'unknown' has a diagnosis pattern entry", () => {
    const patterned = new Set(DIAGNOSIS_PATTERNS.map(p => p.category));
    const missing = declared.filter(c => c !== 'unknown' && !patterned.has(c as ErrorCategory));
    expect(missing).toEqual([]);
  });

  it('no pattern entry references an undeclared category', () => {
    const declaredSet = new Set(declared);
    const stray = DIAGNOSIS_PATTERNS.filter(p => !declaredSet.has(p.category));
    expect(stray.map(p => p.category)).toEqual([]);
  });

  it('every pattern entry has at least one regex and a description', () => {
    for (const entry of DIAGNOSIS_PATTERNS) {
      expect(entry.patterns.length, entry.category).toBeGreaterThan(0);
      expect(entry.description.length, entry.category).toBeGreaterThan(0);
    }
  });
});

describe('category coverage — README table matches the code', () => {
  it('every declared category appears in the README table (unknown included)', () => {
    const inReadme = new Set(readmeCategories());
    const missing = declaredCategories().filter(c => !inReadme.has(c));
    expect(missing).toEqual([]);
  });

  it('the README table lists no category that the code does not declare', () => {
    const declaredSet = new Set(declaredCategories());
    const stale = readmeCategories().filter(c => !declaredSet.has(c));
    expect(stale).toEqual([]);
  });
});

describe('category coverage — fixer paths', () => {
  it('every declared category runs through the fixer orchestrator without throwing', () => {
    const logs = 'Error: Process completed with exit code 1.';
    for (const cat of declaredCategories()) {
      expect(
        () => applyRuleBasedFixes(cat as ErrorCategory, logs, REPRESENTATIVE_FILES),
        cat,
      ).not.toThrow();
    }
  }, 20_000); // ~117 full engine runs — generous budget so a loaded CI runner doesn't flake
});

describe('category coverage — realistic end-to-end spot checks', () => {
  // Hand-verified real-world log phrasings, including the six categories whose
  // patterns needed the most care during the audit.
  const REALISTIC: Array<[ErrorCategory, string]> = [
    ['git_merge_conflict', 'CONFLICT (content): Merge conflict in src/app.ts\n<<<<<<< HEAD\n=======\n>>>>>>> main'],
    ['compilation_failure', 'error TS2345: Argument of type string is not assignable to parameter of type number'],
    ['load_balancer_issue', 'ALB target group health check failing: 503 Service Unavailable from load balancer'],
    ['third_party_failure', 'Snyk API request failed: third-party service returned 503'],
    ['rust_build_failure', 'error[E0433]: failed to resolve: use of undeclared crate or module `tokio`'],
    ['lint_format_failure', 'ESLint found 12 errors and 3 warnings'],
    ['artifact_missing', 'Error: Unable to download artifact: artifact not found for name: build-output'],
    ['cache_restore_failure', 'Warning: Failed to restore cache: Cache service responded with 503'],
  ];

  for (const [category, logText] of REALISTIC) {
    it(`diagnoses and fixes: ${category}`, () => {
      const diag = categorizeAllErrors(logText);
      expect(diag.all.map(d => d.category), `diagnosis for ${category}`).toContain(category);
      const fixes = applyRuleBasedFixes(category, logText, REPRESENTATIVE_FILES);
      expect(fixes.length, `fixes for ${category}`).toBeGreaterThan(0);
    });
  }
});
