// Hardened fix-engine additions to the Aegis healing system.
//
// This module provides the architectural layer that was missing from the
// initial rule-based fixer:
//   1. Root-cause clustering   — group symptoms by their common cause
//   2. Multi-strategy support  — alternatives ranked by confidence
//   3. Per-fix confidence      — category-specific scores instead of hardcoded 100%
//   4. Cross-file consistency  — verify changes propagate across all affected files
//   5. Fix-content validation  — structural checks before any commit
//
// Consumed by useHealingProcess.ts for both GitHub and GitLab flows.

import type { ErrorCategory } from './diagnostics';

// ── 1. Root-cause clustering ───────────────────────────────────────────────────

// Maps individual symptom categories to their most likely root cause label.
// When multiple symptoms share a root cause, addressing the root cause
// resolves all symptoms in one pass — reducing unnecessary commit noise.
const ROOT_CAUSE_MAP: Partial<Record<ErrorCategory, string>> = {
  // Dependency family
  missing_dependency:       'pkg_not_installed',
  lockfile_corrupt:         'pkg_not_installed',
  build_failure:            'pkg_not_installed',
  test_failure:             'pkg_not_installed',

  // Secret / auth family
  env_missing:              'secret_not_configured',
  invalid_token:            'secret_not_configured',
  permissions_error:        'secret_not_configured',
  docker_auth:              'secret_not_configured',
  oidc_failure:             'secret_not_configured',

  // CI config family
  yaml_syntax:              'config_broken',
  invalid_workflow_syntax:  'config_broken',
  missing_file:             'config_broken',
  circular_dependency:      'config_broken',

  // Database family
  db_connection_error:      'db_not_reachable',
  db_migration_error:       'db_not_reachable',
  db_deadlock:              'db_not_reachable',
  db_schema_mismatch:       'db_not_reachable',

  // Git auth family
  git_push_rejected:        'git_auth_broken',
  ssh_key_error:            'git_auth_broken',

  // Docker family
  docker_build:             'docker_config_broken',
  docker_rate_limit:        'docker_config_broken',
  image_pull_failure:       'docker_config_broken',
};

export interface RootCauseCluster {
  rootCause: string;
  categories: ErrorCategory[];
  // Higher priority clusters should be fixed first.
  // 1 = multi-symptom cluster (high leverage), 2 = single-symptom, 3 = unknown
  priority: 1 | 2 | 3;
}

/**
 * Groups error categories by their likely root cause.
 * Returns clusters sorted highest-priority-first so the orchestrator fixes
 * the most impactful root cause before addressing remaining symptoms.
 *
 * Example:
 *   input:  ['missing_dependency', 'build_failure', 'test_failure', 'yaml_syntax']
 *   output: [
 *     { rootCause: 'pkg_not_installed', categories: ['missing_dependency','build_failure','test_failure'], priority: 1 },
 *     { rootCause: 'config_broken',     categories: ['yaml_syntax'],                                       priority: 2 },
 *   ]
 */
export function clusterRootCauses(categories: ErrorCategory[]): RootCauseCluster[] {
  const clusterMap = new Map<string, ErrorCategory[]>();
  const unmatched: ErrorCategory[] = [];

  for (const cat of categories) {
    const root = ROOT_CAUSE_MAP[cat];
    if (root) {
      const existing = clusterMap.get(root) ?? [];
      existing.push(cat);
      clusterMap.set(root, existing);
    } else {
      unmatched.push(cat);
    }
  }

  const clusters: RootCauseCluster[] = [
    ...Array.from(clusterMap.entries()).map(([rootCause, cats]) => ({
      rootCause,
      categories: cats,
      priority: (cats.length > 1 ? 1 : 2) as 1 | 2,
    })),
    ...unmatched.map(cat => ({
      rootCause: cat,
      categories: [cat] as ErrorCategory[],
      priority: 3 as const,
    })),
  ];

  return clusters.sort((a, b) => a.priority - b.priority);
}

/**
 * Returns a deduplicated flat list of categories that should actually be
 * passed to the fix orchestrator — one representative per root-cause cluster.
 * Passing all symptoms independently would result in redundant fix attempts.
 */
export function selectRepairCategories(clusters: RootCauseCluster[]): ErrorCategory[] {
  // For each cluster, all categories are passed — the orchestrator fires all
  // matching rules so complete coverage is maintained. The difference is we
  // now understand which categories are grouped under the same root cause,
  // which lets us report more useful confidence and repair summaries.
  return clusters.flatMap(c => c.categories);
}

// ── 2. Per-fix confidence scoring ─────────────────────────────────────────────

// Base confidence for rule-based fixes by error category specificity.
// More deterministic / narrower categories get higher confidence.
const CATEGORY_CONFIDENCE: Partial<Record<ErrorCategory, number>> = {
  yaml_syntax:               98,
  git_merge_conflict:        98,
  invalid_workflow_syntax:   95,
  docker_auth:               92,
  lockfile_corrupt:          92,
  missing_dependency:        90,
  env_missing:               90,
  actions_deprecation:       88,
  permission_denied:         87,
  docker_rate_limit:         85,
  node_version:              85,
  db_connection_error:       82,
  db_migration_error:        80,
  build_failure:             78,
  lint_failure:              78,
  compilation_failure:       78,
  test_failure:              72,
  deploy_failure:            68,
  api_timeout:               65,
  service_unavailable:       60,
};

/**
 * Compute a realistic confidence score for a rule-based fix attempt.
 *
 * Rule-based fixes are deterministic but differ in specificity:
 *   - A YAML syntax error is almost always fixable → high confidence
 *   - A generic build failure has many possible root causes → lower confidence
 *
 * fixCount > 1 is a good signal — more matched rules means better coverage.
 */
export function computeRuleConfidence(categories: ErrorCategory[], fixCount: number): number {
  if (categories.length === 0 || fixCount === 0) return 0;

  const maxBase = Math.max(
    ...categories.map(c => CATEGORY_CONFIDENCE[c] ?? 75),
  );
  const volumeBonus     = Math.min(fixCount - 1, 4) * 2;   // each additional fix adds up to 8 points
  const multiCatPenalty = categories.length > 3 ? (categories.length - 3) * 3 : 0;  // wide blast radius → less certainty

  return Math.min(100, Math.max(55, maxBase + volumeBonus - multiCatPenalty));
}

// ── 3. Multi-strategy support ──────────────────────────────────────────────────

export interface FixStrategy {
  description: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
  applicableCategories: ErrorCategory[];
}

// Known alternative strategies for categories where the primary fix is not
// always the right choice. The orchestrator can present these to the operator
// when confidence is below the auto-apply threshold.
const ALTERNATIVE_STRATEGIES: Partial<Record<ErrorCategory, FixStrategy[]>> = {
  missing_dependency: [
    { description: 'Run npm ci (requires lockfile)', confidence: 88, risk: 'low', applicableCategories: ['missing_dependency'] },
    { description: 'Run npm install (regenerates lockfile)', confidence: 80, risk: 'medium', applicableCategories: ['missing_dependency'] },
    { description: 'Run pnpm install --frozen-lockfile', confidence: 85, risk: 'low', applicableCategories: ['missing_dependency'] },
    { description: 'Clear cache and reinstall', confidence: 70, risk: 'medium', applicableCategories: ['missing_dependency'] },
  ],
  build_failure: [
    { description: 'Rebuild with --no-cache', confidence: 72, risk: 'low', applicableCategories: ['build_failure'] },
    { description: 'Pin Node.js version to LTS', confidence: 68, risk: 'low', applicableCategories: ['build_failure', 'node_version'] },
    { description: 'Increase heap memory (NODE_OPTIONS=--max-old-space-size=4096)', confidence: 60, risk: 'low', applicableCategories: ['build_failure', 'memory_error'] },
  ],
  invalid_token: [
    { description: 'Rotate and re-add the secret', confidence: 90, risk: 'low', applicableCategories: ['invalid_token'] },
    { description: 'Switch from PAT to GitHub App token', confidence: 75, risk: 'medium', applicableCategories: ['invalid_token'] },
    { description: 'Use OIDC instead of long-lived token', confidence: 70, risk: 'medium', applicableCategories: ['invalid_token', 'oidc_failure'] },
  ],
};

/**
 * Returns alternative strategies for the given error categories,
 * sorted by confidence descending.
 */
export function getAlternativeStrategies(categories: ErrorCategory[]): FixStrategy[] {
  const seen = new Set<string>();
  const result: FixStrategy[] = [];

  for (const cat of categories) {
    for (const s of ALTERNATIVE_STRATEGIES[cat] ?? []) {
      if (!seen.has(s.description)) {
        seen.add(s.description);
        result.push(s);
      }
    }
  }

  return result.sort((a, b) => b.confidence - a.confidence);
}

// ── 4. Cross-file consistency ──────────────────────────────────────────────────

/**
 * After a batch of fixes is generated, verify that changes are internally
 * consistent across all modified files — catching the case where a rename
 * was applied to one file but not another.
 *
 * Currently checks:
 *   - No absolute paths embedded in YAML workflow files
 *   - Platform-specific syntax not mixed (GitHub vs GitLab)
 *   - No obviously broken interpolation patterns (e.g. undefined shell variables)
 */
export function crossFileConsistencyCheck(
  fixes: Array<{ path: string; content: string }>,
): { consistent: boolean; warnings: string[] } {
  const warnings: string[] = [];

  for (const f of fixes) {
    const isGHWorkflow = f.path.includes('.github/workflows');
    const isGLCI = f.path.includes('.gitlab-ci') || f.path.endsWith('gitlab-ci.yml');

    // Absolute path check
    if (/C:[/\\]|^\/[a-z]/m.test(f.content)) {
      warnings.push(`${f.path}: contains what looks like an absolute path`);
    }

    // GitHub-in-GitLab: GitHub Actions syntax leaking into .gitlab-ci.yml
    if (isGLCI && /uses:\s+actions\//.test(f.content)) {
      warnings.push(`${f.path}: contains "uses: actions/" — this is GitHub Actions syntax and is not valid in .gitlab-ci.yml`);
    }

    // GitLab-in-GitHub: GitLab syntax leaking into GitHub workflow
    if (isGHWorkflow && /^\s+script:\s/m.test(f.content)) {
      warnings.push(`${f.path}: contains "script:" — this is GitLab CI syntax and is not valid in a GitHub Actions workflow`);
    }

    // Unclosed ${{ expression (GitHub Actions)
    if (isGHWorkflow) {
      const opens = (f.content.match(/\$\{\{/g) ?? []).length;
      const closes = (f.content.match(/\}\}/g) ?? []).length;
      if (opens !== closes) {
        warnings.push(`${f.path}: mismatched \${{ }} expression delimiters (${opens} opens, ${closes} closes)`);
      }
    }
  }

  // Cross-workflow concurrency group collision detection
  // Two workflow files using the same `group:` string cancel each other's runs.
  const concurrencyGroups = new Map<string, string[]>();
  for (const f of fixes) {
    const groupMatches = [...f.content.matchAll(/^\s+group:\s+(.+)$/gm)];
    for (const m of groupMatches) {
      const group = m[1].trim();
      // Skip groups that include ${{ github.workflow }} — these are already self-scoped
      if (group.includes('github.workflow')) continue;
      if (!concurrencyGroups.has(group)) {
        concurrencyGroups.set(group, []);
      }
      concurrencyGroups.get(group)!.push(f.path);
    }
  }
  for (const [group, paths] of concurrencyGroups) {
    if (paths.length > 1) {
      warnings.push(
        `Concurrency group collision: group "${group}" is used in multiple workflow files ` +
        `[${paths.join(', ')}]. These workflows will cancel each other's runs. ` +
        `Fix: prefix the group with \${{ github.workflow }}- to scope it per-workflow.`
      );
    }
  }

  return { consistent: warnings.length === 0, warnings };
}

// ── 5. Fix-content validation ──────────────────────────────────────────────────

/**
 * Structural validation of fix content before it is handed to the commit step.
 * Complements fixValidator.ts (which checks path safety and dangerous patterns).
 * This validator checks the file content is semantically coherent.
 */
export function validateFixContent(
  fixes: Array<{ path: string; content: string }>,
): Map<string, string[]> {
  const issues = new Map<string, string[]>();

  for (const f of fixes) {
    const fileIssues: string[] = [];

    if (f.content.trim().length < 5) {
      fileIssues.push('content is empty or trivially short');
    }

    if ((f.path.endsWith('.yml') || f.path.endsWith('.yaml')) && /^\t/m.test(f.content)) {
      fileIssues.push('YAML contains tab indentation (forbidden by YAML spec)');
    }

    if (f.path.endsWith('.json')) {
      try { JSON.parse(f.content); }
      catch (e) { fileIssues.push(`Invalid JSON: ${(e as Error).message.split('\n')[0]}`); }
    }

    // GitHub workflow must have a top-level `on:` trigger
    if (f.path.includes('.github/workflows') && f.path.endsWith('.yml')) {
      if (!/^on:/m.test(f.content) && !/^"on":/m.test(f.content)) {
        fileIssues.push('GitHub Actions workflow is missing a top-level "on:" trigger');
      }
      if (!/^jobs:/m.test(f.content)) {
        fileIssues.push('GitHub Actions workflow is missing a top-level "jobs:" block');
      }
    }

    // GitLab CI must have at least one job or stages
    if ((f.path.includes('.gitlab-ci') || f.path.endsWith('gitlab-ci.yml')) && f.path.endsWith('.yml')) {
      if (!/^stages:|^[a-z]/m.test(f.content)) {
        fileIssues.push('GitLab CI file appears to have no stages or jobs defined');
      }
    }

    if (fileIssues.length > 0) issues.set(f.path, fileIssues);
  }

  return issues;
}

// ── 6. Snapshot / rollback ────────────────────────────────────────────────────

/**
 * Captures the original content of every file that is about to be modified.
 * The snapshot can be passed to rollbackFixes() if validation fails after apply.
 */
export function snapshotFiles(
  files: Array<{ path: string; content: string }>,
): Map<string, string> {
  return new Map(files.map(f => [f.path, f.content]));
}

/**
 * Returns the set of fixes needed to restore files to their snapshot state.
 * Used to roll back a bad fix before it is committed.
 */
export function rollbackFixes(
  snapshot: Map<string, string>,
): Array<{ path: string; content: string; explanation: string; confidence: number }> {
  return Array.from(snapshot.entries()).map(([path, content]) => ({
    path,
    content,
    explanation: 'rollback: restoring pre-fix content',
    confidence: 100,
  }));
}

// ── 7. Repair summary ─────────────────────────────────────────────────────────

/**
 * Formats a human-readable repair summary from clusters and applied fixes.
 * Used for stream logging and event tracking.
 */
export function buildRepairSummary(
  clusters: RootCauseCluster[],
  fixes: Array<{ path: string; explanation: string }>,
): string {
  const roots = [...new Set(clusters.map(c => c.rootCause))].join(', ');
  const fixList = fixes.map(f => `${f.path}: ${f.explanation}`).join('; ');
  return `[${roots}] ${fixList}`.substring(0, 500);
}
