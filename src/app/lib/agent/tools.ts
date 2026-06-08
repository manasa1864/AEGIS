/**
 * agent/tools.ts
 *
 * Two things live here:
 *   1. TOOL_DECLARATIONS — the JSON schemas Gemini reads to know what tools exist.
 *   2. The actual tool functions — what runs when Gemini decides to call a tool.
 *
 * To add a new tool: add its schema to TOOL_DECLARATIONS, add its function below,
 * and add a case for it in loop.ts → callTool().
 */

import type { Severity } from './types';

// ── 1. Tool schemas (sent to Gemini) ──────────────────────────────────────────

export const TOOL_DECLARATIONS = [
  {
    name: 'analyze_pipeline_failure',
    description: 'Analyzes CI/CD pipeline logs and error messages to identify the root cause of the failure.',
    parameters: {
      type: 'OBJECT',
      properties: {
        logs:          { type: 'STRING', description: 'The full pipeline log output' },
        error_message: { type: 'STRING', description: 'The primary error message from the pipeline' },
        failed_stage:  { type: 'STRING', description: 'The stage name where the pipeline failed' },
      },
      required: ['logs', 'error_message', 'failed_stage'],
    },
  },
  {
    name: 'classify_severity',
    description: 'Classifies how critical a CI/CD failure is based on its root cause and context.',
    parameters: {
      type: 'OBJECT',
      properties: {
        root_cause:   { type: 'STRING', description: 'The identified root cause from analyze_pipeline_failure' },
        failed_stage: { type: 'STRING', description: 'The stage where the pipeline failed' },
        branch:       { type: 'STRING', description: 'The branch name (main/master failures are more critical)' },
      },
      required: ['root_cause', 'failed_stage', 'branch'],
    },
  },
  {
    name: 'suggest_fix',
    description: 'Generates concrete, step-by-step fix instructions for a CI/CD failure.',
    parameters: {
      type: 'OBJECT',
      properties: {
        root_cause:   { type: 'STRING', description: 'The root cause of the failure' },
        severity:     { type: 'STRING', description: 'Severity level: critical, high, medium, or low' },
        project_name: { type: 'STRING', description: 'The name of the project (for context)' },
      },
      required: ['root_cause', 'severity'],
    },
  },
  {
    name: 'decide_auto_heal',
    description: 'Decides whether the pipeline failure can be automatically healed or needs a human.',
    parameters: {
      type: 'OBJECT',
      properties: {
        severity:   { type: 'STRING', description: 'Severity level of the failure' },
        root_cause: { type: 'STRING', description: 'The root cause category' },
        fix_steps:  { type: 'ARRAY', items: { type: 'STRING' }, description: 'The suggested fix steps' },
      },
      required: ['severity', 'root_cause', 'fix_steps'],
    },
  },
];

// ── 2. Tool implementations ───────────────────────────────────────────────────

export function analyzePipelineFailure(args: {
  logs: string;
  error_message: string;
  failed_stage: string;
}): { root_cause: string; category: string; patterns_found: string[] } {
  const text = ((args.logs ?? '') + ' ' + (args.error_message ?? '')).toLowerCase();
  const patterns: string[] = [];

  // Each entry: [regex to match, human-readable cause, internal category key]
  const checks: [RegExp, string, string][] = [
    [/npm err|yarn error|pnpm error|module not found|cannot find module/i, 'Dependency installation failed', 'dependency'],
    [/econnrefused|connection refused|network timeout|etimedout/i,         'Network connectivity issue',     'network'],
    [/permission denied|eacces|forbidden|unauthorized|401|403/i,           'Permission or authentication error', 'auth'],
    [/oomkilled|out of memory|memory limit exceeded|heap out of memory/i,  'Out of memory (OOM)',            'memory'],
    [/command not found|no such file or directory/i,                       'Missing binary or command',      'environment'],
    [/test.*fail|fail.*test|assertion.*error|jest|mocha|pytest.*fail/i,    'Test suite failures',            'test'],
    [/syntax error|unexpected token|parse error|compilation error/i,       'Build or compilation error',     'build'],
    [/docker.*error|container.*fail|image.*not found|registry/i,           'Docker or container error',      'docker'],
    [/timeout|timed out|deadline exceeded/i,                               'Pipeline step timed out',        'timeout'],
    [/merge conflict|conflict.*merge/i,                                    'Merge conflict in code',         'conflict'],
  ];

  let category = 'unknown';
  let root_cause = 'Unknown failure — manual investigation required';

  for (const [pattern, cause, cat] of checks) {
    if (pattern.test(text)) {
      patterns.push(cause);
      if (category === 'unknown') {   // First match wins as primary cause
        root_cause = cause;
        category = cat;
      }
    }
  }

  return { root_cause, category, patterns_found: patterns };
}

export function classifySeverity(args: {
  root_cause: string;
  failed_stage: string;
  branch: string;
}): { severity: Severity; reason: string } {
  const isProtectedBranch = /^(main|master|release|production|prod)$/i.test(args.branch);
  const stage = (args.failed_stage ?? '').toLowerCase();
  const cause = (args.root_cause ?? '').toLowerCase();

  if (cause.includes('memory') || (isProtectedBranch && stage.includes('deploy'))) {
    return { severity: 'critical', reason: 'Memory issue or deploy failure on a protected branch' };
  }
  if (cause.includes('auth') || cause.includes('permission') || stage.includes('deploy')) {
    return { severity: 'high', reason: 'Auth/permission issue or deployment stage failure' };
  }
  if (cause.includes('test') || cause.includes('build') || cause.includes('network')) {
    return { severity: 'medium', reason: 'Test, build, or network failure' };
  }
  return { severity: 'low', reason: 'Non-critical environment or configuration issue' };
}

export function suggestFix(args: {
  root_cause: string;
  severity: string;
  project_name?: string;
}): { steps: string[]; estimated_time: string } {
  const cause = (args.root_cause ?? '').toLowerCase();

  const fixMap: Record<string, { steps: string[]; time: string }> = {
    dependency: {
      steps: [
        'Delete node_modules and the lock file (pnpm-lock.yaml / package-lock.json)',
        'Run `pnpm install` (or npm install) to reinstall from scratch',
        'Check for version conflicts in package.json',
        'Verify private registry credentials if using a private npm registry',
      ],
      time: '5–10 minutes',
    },
    network: {
      steps: [
        'Check runner network connectivity and firewall rules',
        'Verify external service endpoints are reachable from the CI environment',
        'Add retry logic (--retry flag or retry: on_failure in .gitlab-ci.yml)',
        'Consider caching external dependencies to reduce network calls',
      ],
      time: '10–20 minutes',
    },
    auth: {
      steps: [
        'Verify CI/CD secret variables are set correctly in project settings',
        'Check if tokens or API keys have expired — rotate if necessary',
        'Ensure the service account has the required permissions',
        'Review recent changes to access control or IAM policies',
      ],
      time: '5–15 minutes',
    },
    memory: {
      steps: [
        'Increase runner memory limit in runner config or job variables',
        'Optimize the build to reduce peak memory (enable swap, reduce parallelism)',
        'Split large build jobs into smaller parallel stages',
        'Profile memory usage locally to identify the leak or spike',
      ],
      time: '15–30 minutes',
    },
    environment: {
      steps: [
        'Verify required tools are installed in the CI base Docker image',
        'Update .gitlab-ci.yml / workflow YAML to install missing dependencies before the failing step',
        'Pin a specific Docker image version to prevent environment drift',
        'Check PATH and environment variable configuration in runner settings',
      ],
      time: '10–20 minutes',
    },
    test: {
      steps: [
        'Review the failing test output for specific assertion errors',
        'Check if failures are due to a real code bug — fix the code first',
        'Verify test environment variables and database seeding scripts',
        'Identify flaky tests and add retry logic or stabilize them',
      ],
      time: '20–60 minutes',
    },
    build: {
      steps: [
        'Fix syntax or compilation errors shown in the build log',
        'Ensure the correct compiler or runtime version is specified in CI',
        'Review recent commits that may have introduced the error',
        'Run the build locally with `pnpm build` to reproduce and debug',
      ],
      time: '10–30 minutes',
    },
    docker: {
      steps: [
        'Verify the Docker image name and tag exist in the registry',
        'Check registry authentication credentials stored in CI secrets',
        'Ensure Docker-in-Docker (dind) is enabled on the runner if required',
        'Review the Dockerfile for syntax errors or missing base images',
      ],
      time: '10–20 minutes',
    },
    timeout: {
      steps: [
        'Increase the timeout value for the failing job in .gitlab-ci.yml',
        'Identify and optimize slow steps — add caching or parallelization',
        'Break large jobs into smaller focused stages',
        'Check for hanging processes or blocking network calls',
      ],
      time: '15–30 minutes',
    },
    conflict: {
      steps: [
        'Pull the latest changes from the target branch',
        'Resolve merge conflicts locally and commit the resolution',
        'Re-run the pipeline after pushing the resolved code',
        'Consider rebasing instead of merging for a cleaner history',
      ],
      time: '10–30 minutes',
    },
  };

  for (const [key, fix] of Object.entries(fixMap)) {
    if (cause.includes(key)) return { steps: fix.steps, estimated_time: fix.time };
  }

  return {
    steps: [
      'Review the full pipeline log for specific error details',
      'Reproduce the failure locally if possible',
      'Check recent commits for changes related to the failing stage',
      'Contact the team or open an issue if the cause is unclear',
    ],
    estimated_time: '30–60 minutes',
  };
}

export function decideAutoHeal(args: {
  severity: string;
  root_cause: string;
  fix_steps: string[];
}): { auto_healable: boolean; reason: string } {
  if (args.severity === 'critical') {
    return { auto_healable: false, reason: 'Critical severity always requires human review before action' };
  }

  // These failure types are safe to retry automatically
  const safeToRetry = ['dependency', 'network', 'timeout', 'environment'];
  for (const category of safeToRetry) {
    if ((args.root_cause ?? '').toLowerCase().includes(category)) {
      return {
        auto_healable: true,
        reason: `${args.root_cause ?? category} failures are transient and safe to retry automatically`,
      };
    }
  }

  return {
    auto_healable: false,
    reason: 'This failure requires a code or configuration change — human intervention needed',
  };
}
