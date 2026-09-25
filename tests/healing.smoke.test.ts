// End-to-end smoke tests of the offline healing pipeline:
//   logs → categorizeAllErrors → applyRuleBasedFixes → validateFixes
// for BOTH providers (GitHub Actions and GitLab CI), no network required.

import { describe, it, expect } from 'vitest';
import { categorizeAllErrors, categorizeError } from '../src/app/lib/diagnostics';
import { applyRuleBasedFixes } from '../src/app/lib/ruleBasedFixer';
import { validateFixes } from '../src/app/lib/fixValidator';
import { confidenceToLevel } from '../src/app/lib/errorLevel';
import { parseRepoUrl } from '../src/app/lib/github';

describe('diagnostics', () => {
  it('detects a missing npm dependency from logs', () => {
    const d = categorizeError("npm ERR! code MODULE_NOT_FOUND\nnpm ERR! Cannot find module 'express'");
    expect(d.category).not.toBe('unknown');
  });

  it('detects YAML syntax errors', () => {
    const d = categorizeAllErrors('Invalid workflow file: .github/workflows/ci.yml#L5\nYou have an error in your yaml syntax on line 5');
    expect(d.all.length).toBeGreaterThan(0);
  });

  it('returns unknown for empty logs without crashing', () => {
    const d = categorizeError('');
    expect(d.category).toBe('unknown');
  });

  it('ranks multiple simultaneous failures', () => {
    const logs = [
      "npm ERR! Cannot find module 'lodash'",
      'Error: Process completed with exit code 1.',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    ].join('\n');
    const multi = categorizeAllErrors(logs);
    expect(multi.all.length).toBeGreaterThanOrEqual(2);
    expect(multi.primary).toBeDefined();
  });
});

describe('rule-based healing — GitHub Actions', () => {
  it('fixes tab indentation in a workflow file', () => {
    const files = [{
      path: '.github/workflows/ci.yml',
      content: 'name: CI\non: [push]\njobs:\n\tbuild:\n\t\truns-on: ubuntu-latest\n',
    }];
    const fixes = applyRuleBasedFixes('yaml_syntax', 'YAML syntax error: found a tab character', files);
    expect(fixes.length).toBeGreaterThan(0);
    const fixed = fixes.find(f => f.path === '.github/workflows/ci.yml');
    expect(fixed).toBeDefined();
    expect(fixed!.content).not.toMatch(/^\t/m);
  });

  it('upgrades deprecated action versions', () => {
    const files = [{
      path: '.github/workflows/ci.yml',
      content: 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v2\n      - uses: actions/setup-node@v2\n',
    }];
    const fixes = applyRuleBasedFixes('actions_deprecation', 'Node.js 12 actions are deprecated. Please update to v4', files);
    const fixed = fixes.find(f => f.path.includes('ci.yml'));
    expect(fixed).toBeDefined();
    expect(fixed!.content).not.toContain('checkout@v2');
  });

  it('produced fixes pass the safety validator', () => {
    const files = [{
      path: '.github/workflows/ci.yml',
      content: 'name: CI\non: [push]\njobs:\n\ttest:\n\t\truns-on: ubuntu-latest\n',
    }];
    const fixes = applyRuleBasedFixes(['yaml_syntax'], 'yaml syntax error: tab found', files);
    const { safeFixes, results } = validateFixes(fixes, files);
    expect(results.every(r => r.blocked.length === 0)).toBe(true);
    expect(safeFixes.length).toBe(fixes.length);
  });
});

describe('rule-based healing — GitLab CI', () => {
  it('fixes tab indentation in .gitlab-ci.yml', () => {
    const files = [{
      path: '.gitlab-ci.yml',
      content: 'stages:\n\t- build\nbuild-job:\n\tstage: build\n\tscript:\n\t\t- echo build\n',
    }];
    const fixes = applyRuleBasedFixes('invalid_gitlab_ci', 'jobs config should contain at least one visible job\nfound character that cannot start any token', files);
    expect(fixes.length).toBeGreaterThan(0);
    const fixed = fixes.find(f => f.path === '.gitlab-ci.yml');
    expect(fixed).toBeDefined();
    expect(fixed!.content).not.toMatch(/^\t/m);
  });

  it('handles a multi-category GitLab failure without crashing', () => {
    const files = [{
      path: '.gitlab-ci.yml',
      content: 'image: node:14\nstages:\n  - test\ntest-job:\n  stage: test\n  script:\n    - npm ci\n    - npm test\n',
    }];
    const logs = [
      "npm ERR! Cannot find module 'jest'",
      'ERROR: Job failed: exit code 1',
    ].join('\n');
    const multi = categorizeAllErrors(logs);
    const fixes = applyRuleBasedFixes(multi.all.map(d => d.category), logs, files);
    // Must never throw and every produced fix must be structurally valid
    const { results } = validateFixes(fixes, files);
    expect(results.every(r => r.blocked.length === 0)).toBe(true);
  });
});

describe('rule-based healing — robustness', () => {
  it('tolerates malformed fix inputs (missing path/content)', () => {
    const files = [
      { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs: {}\n' },
      { path: undefined as unknown as string, content: 'x' },
      { path: 'a.yml', content: undefined as unknown as string },
    ];
    expect(() => applyRuleBasedFixes('unknown', '', files)).not.toThrow();
  });

  it('runs every category through the orchestrator without throwing', () => {
    const files = [
      { path: '.github/workflows/ci.yml', content: 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci && npm test\n' },
      { path: '.gitlab-ci.yml', content: 'stages: [test]\ntest:\n  stage: test\n  script: [npm test]\n' },
      { path: 'package.json', content: '{"name":"x","version":"1.0.0","scripts":{"test":"jest"}}' },
    ];
    const logs = 'Error: Process completed with exit code 1.';
    // A representative spread across simple / intermediate / advanced tiers
    const categories = [
      'yaml_syntax', 'missing_dependency', 'env_missing', 'build_failure', 'test_failure',
      'docker_auth', 'docker_build', 'git_merge_conflict', 'cache_failure',
      'db_connection_error', 'db_migration_error', 'deploy_failure', 'api_timeout',
      'invalid_gitlab_ci', 'invalid_workflow_syntax', 'unknown',
    ] as const;
    for (const cat of categories) {
      expect(() => applyRuleBasedFixes(cat as never, logs, files)).not.toThrow();
    }
  });
});

describe('supporting utilities', () => {
  it('maps confidence to error levels at documented thresholds', () => {
    expect(confidenceToLevel(90, true)).toBe('LOW');
    expect(confidenceToLevel(70, true)).toBe('MEDIUM');
    expect(confidenceToLevel(40, true)).toBe('HIGH');
    expect(confidenceToLevel(95, false)).toBe('HIGH');
  });

  it('parses GitHub repo URLs in common shapes', () => {
    expect(parseRepoUrl('https://github.com/octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
    expect(parseRepoUrl('github.com/octocat/hello-world.git')).toEqual({ owner: 'octocat', repo: 'hello-world' });
    expect(parseRepoUrl('not-a-repo')).toBeNull();
  });
});
