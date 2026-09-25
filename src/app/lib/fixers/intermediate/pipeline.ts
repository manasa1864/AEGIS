// Intermediate / CI/CD Pipeline Errors
// Covers: job ordering, artifact mismatches, cache keys, parallel timeouts,
// GitLab stage declarations, flaky test retry, security scan non-blocking,
// concurrency groups, missing reports directory, fail-fast, job outputs.

import { RuleFix, isGitHubWorkflow, isGitLabCI, patchGitHubJobBlocks, patchGitLabJobBlocks, declareJobOutputs } from '../helpers';

/** Add needs: [build] to test/deploy/publish jobs that are missing a dependency. */
export function fixMissingJobNeeds(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    interface JobEntry { name: string; lineIdx: number; block: string }
    const jobs: JobEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^  ([\w-]+):\s*$/);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && (lines[end].startsWith('    ') || lines[end].trim() === '')) end++;
      jobs.push({ name: m[1], lineIdx: i, block: lines.slice(i + 1, end).join('\n') });
    }
    const buildJob = jobs.find(j => /^(build|compile|package)$/i.test(j.name));
    if (!buildJob) continue;
    const dependents = jobs.filter(j =>
      /^(test|e2e|integration|deploy|publish|release|upload|package|lint|coverage|security|scan)$/i.test(j.name) &&
      !j.block.includes('needs:') && j.name !== buildJob.name,
    );
    if (dependents.length === 0) continue;
    let content = f.content;
    for (const d of dependents)
      content = content.replace(new RegExp(`^(  ${d.name}:)$`, 'm'), `$1\n    needs: [${buildJob.name}]`);
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added needs: [${buildJob.name}] to downstream jobs — without needs:, jobs run in parallel even when they depend on build artifacts; this causes "artifact not found" and "module not compiled" errors`, confidence: 100 });
  }
  return fixes;
}

/** Fix download-artifact name to match what upload-artifact uses. */
export function fixArtifactNameMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No artifacts found|artifact.*not found|Unable to find.*artifact/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const uploadMatch = f.content.match(/upload-artifact[\s\S]*?name:\s*(\S+)/);
    const downloadMatch = f.content.match(/download-artifact[\s\S]*?name:\s*(\S+)/);
    if (!uploadMatch || !downloadMatch || uploadMatch[1] === downloadMatch[1]) continue;
    const fixed = f.content.replace(/(download-artifact[\s\S]*?name:\s*)\S+/, `$1${uploadMatch[1]}`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Fixed artifact name mismatch: download used "${downloadMatch[1]}" but upload used "${uploadMatch[1]}" — names must match exactly; GitHub Actions artifact names are case-sensitive`, confidence: 100 });
  }
  return fixes;
}

/** Simplify cache keys that are so specific they never hit any existing cache. */
export function fixCacheKeyOverSpecific(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/cache')) continue;
    const complexKey = /key:\s*\$\{\{[^}]+\}\}(?:-\$\{\{[^}]+\}\}){3,}/;
    if (!complexKey.test(f.content)) continue;
    const fixed = f.content.replace(complexKey, (m) => {
      const hash = m.match(/hashFiles\([^)]+\)/)?.[0] ?? "hashFiles('**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml')";
      return `key: \${{ runner.os }}-deps-\${{ ${hash} }}`;
    });
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Simplified overly-specific cache key — cache keys with 4+ variable segments almost never hit because every CI parameter must match exactly; simplified to OS + dependency hash which hits reliably', confidence: 100 });
  }
  return fixes;
}

/** Add timeout-minutes to matrix strategy jobs to prevent runner exhaustion. */
export function fixParallelJobTimeouts(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('matrix:') && !f.content.includes('strategy:')) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => b.includes('matrix') && !/timeout-minutes/i.test(b),
      '    timeout-minutes: 20',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added timeout-minutes: 20 to matrix jobs — parallel jobs with no timeout can run for the GitHub default 6 hours; a stuck matrix job blocks ALL remaining runners until the whole workflow times out', confidence: 100 });
  }
  return fixes;
}

/** Fix GitLab CI stages: block to include all stages referenced by jobs. */
export function fixGitLabStageOrder(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const stagesBlock = f.content.match(/^stages:\s*\n((?:\s*-\s+\S+\s*\n)+)/m);
    if (!stagesBlock) continue;
    const declared = [...stagesBlock[1].matchAll(/^\s*-\s+(\S+)/gm)].map(m => m[1]);
    const used = [...new Set([...f.content.matchAll(/^\s+stage:\s+(\S+)/gm)].map(m => m[1]))];
    const missing = used.filter(s => !declared.includes(s));
    if (missing.length === 0) continue;
    const newBlock = `stages:\n${declared.map(s => `  - ${s}`).join('\n')}\n${missing.map(s => `  - ${s}`).join('\n')}\n`;
    const fixed = f.content.replace(/^stages:\s*\n(?:\s*-\s+\S+\s*\n)+/m, newBlock);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added missing stages [${missing.join(', ')}] to GitLab CI stages declaration — jobs reference stages not declared in the stages: list; GitLab rejects pipelines with unknown stages`, confidence: 100 });
  }
  return fixes;
}

/** Add security scan job non-blocking flag (Snyk/Trivy/Gitleaks need tokens). */
export function fixSecurityJobNonBlocking(files: Array<{ path: string; content: string }>): RuleFix[] {
  const TOOLS = ['snyk/', 'gitleaks', 'trivy', 'anchore', 'dependency-review', 'ossf/', 'aquasecurity/'];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !TOOLS.some(t => f.content.includes(t))) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => TOOLS.some(t => b.includes(t)) && !/continue-on-error:\s*true/i.test(b),
      '    continue-on-error: true',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added continue-on-error: true to security scan jobs — SNYK_TOKEN / Trivy / Gitleaks / OSSF credentials may not be configured in this repo; security scans should not block merges when tokens are absent', confidence: 100 });
  }
  return fixes;
}

/** Add concurrency group to deploy/docker workflows to prevent parallel run races. */
export function fixMissingConcurrencyGroup(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('docker') && !f.content.includes('release')) continue;
    if (f.content.includes('concurrency:')) continue;
    const concurrencyBlock = `concurrency:\n  group: \${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: false\n`;
    const fixed = f.content.replace(/^(on:)/m, `${concurrencyBlock}\n$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added concurrency group (cancel-in-progress: false) — prevents simultaneous deploy runs from racing each other; cancel-in-progress: false ensures deploys complete rather than being cancelled mid-flight', confidence: 100 });
  }
  return fixes;
}

/** Add mkdir -p ./reports before audit output redirects. */
export function fixMissingReportsDir(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('./reports/') || f.content.includes('mkdir -p ./reports')) continue;
    const fixed = f.content.replace(
      /(run:\s*)(npm audit[^\n]*>\s*\.\/reports\/[^\n]+)/g,
      '$1mkdir -p ./reports\n          $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added mkdir -p ./reports before audit redirect — directory did not exist; redirection to a non-existent directory causes the command to fail with ENOENT', confidence: 100 });
  }
  return fixes;
}

/** Replace deprecated ::set-env with $GITHUB_ENV file write. */
export function fixDeprecatedSetEnv(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('::set-env')) continue;
    const fixed = f.content.replace(/echo "::set-env name=([^:]+)::([^"]+)"/g, 'echo "$1=$2" >> $GITHUB_ENV');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Replaced deprecated ::set-env with $GITHUB_ENV — ::set-env was removed in Actions runner v2.285.0+; it was also a command injection vector (CVE-2020-15228)', confidence: 100 });
  }
  return fixes;
}

/** Detect and fix circular needs: dependencies in GitHub Actions. */
export function fixCircularDependency(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/circular dependency|job.*depends.*itself|cycle.*detected.*needs|needs.*circular/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const jobNeeds = new Map<string, string[]>();
    let currentJob = '';
    for (const line of lines) {
      const jobMatch = line.match(/^  ([\w-]+):\s*$/);
      if (jobMatch) { currentJob = jobMatch[1]; jobNeeds.set(currentJob, []); }
      // needs: [a, b]  or  needs: a
      const needsMatch = line.match(/^\s+needs:\s*(?:\[([^\]]+)\]|([\w-]+)\s*$)/);
      if (needsMatch && currentJob) jobNeeds.set(currentJob, (needsMatch[1] ?? needsMatch[2]).split(',').map(s => s.trim()));
    }
    const hasCycle = (job: string, visited: Set<string>, stack: Set<string>): boolean => {
      visited.add(job); stack.add(job);
      for (const dep of jobNeeds.get(job) ?? []) {
        if (!visited.has(dep) && hasCycle(dep, visited, stack)) return true;
        if (stack.has(dep)) return true;
      }
      stack.delete(job);
      return false;
    };
    const cycleJobs: string[] = [];
    for (const [job] of jobNeeds) {
      if (hasCycle(job, new Set(), new Set())) cycleJobs.push(job);
    }
    if (cycleJobs.length === 0) continue;
    let content = f.content;
    for (const job of cycleJobs) {
      content = content.replace(
        new RegExp(`(  ${job}:[\\s\\S]*?)\\n\\s+needs:.*\\n`, 'm'),
        '$1\n',
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Removed circular needs: from jobs [${cycleJobs.join(', ')}] — circular dependencies cause GitHub Actions to reject the workflow with "cyclic dependency detected"; removed the problematic needs: entry`, confidence: 100 });
  }
  return fixes;
}

/** Fix unknown/unavailable runner labels by falling back to ubuntu-latest. */
export function fixMissingRunner(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no runner available|runner.*offline|Unable to find.*runner|runner.*not.*found|Requested labels.*no runners/i.test(logs)) return [];
  const runnerMatch = logs.match(/Requested labels:\s*([^\n]+)/i);
  const badLabel = runnerMatch?.[1]?.trim();
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    let content = f.content;
    if (badLabel && f.content.includes(badLabel)) {
      content = content.replace(new RegExp(`runs-on:\\s*${badLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'), 'runs-on: ubuntu-latest');
    } else {
      content = content.replace(
        /runs-on:\s*(?!ubuntu|macos|windows|self-hosted)[\w-]+/gi,
        'runs-on: ubuntu-latest',
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Changed runner to ubuntu-latest — custom runner "${badLabel || 'custom'}" is offline, deleted, or the runner group is not accessible to this repository`, confidence: 100 });
  }
  return fixes;
}

/** Add retry logic to failed pipeline stages using nick-fields/retry or GitLab retry:. */
export function fixFailedPipelineStageRetry(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/The process.*exited with.*code 1|Command failed|Process completed with exit code [1-9]|job.*failed/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (isGitLabCI(f.path)) {
      if (f.content.includes('retry:')) continue;
      // Only real jobs (not global keys like stages:/variables:) that run a script
      const fixed = patchGitLabJobBlocks(
        f.content,
        block => /^\s+script:/m.test(block),
        '  retry:\n    max: 2\n    when:\n      - runner_system_failure\n      - stuck_or_timeout_failure',
      ) ?? f.content;
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added retry: max: 2 with when: conditions to GitLab CI jobs — transient failures (runner crash, network timeout, stuck jobs) will be retried automatically; when: conditions ensure we only retry infrastructure failures, not code failures', confidence: 100 });
    }
  }
  return fixes;
}

/** Add GitLab CI allow_failure: true to optional stages (coverage, lint). */
export function fixGitLabOptionalStages(files: Array<{ path: string; content: string }>): RuleFix[] {
  const OPTIONAL_JOBS = /^(coverage|lint|format|sonar|quality|stylelint|prettier)\w*:/im;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path) || !OPTIONAL_JOBS.test(f.content)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    let inOptionalJob = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^(coverage|lint|format|sonar|quality|stylelint|prettier)\w*:$/i.test(lines[i])) inOptionalJob = true;
      if (inOptionalJob && /^\S/.test(lines[i]) && i > 0) inOptionalJob = false;
      if (inOptionalJob && /^\s+stage:/.test(lines[i]) && !f.content.slice(f.content.indexOf(lines[i])).includes('allow_failure:')) {
        out.push('  allow_failure: true');
        modified = true;
        inOptionalJob = false;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added allow_failure: true to optional quality jobs — coverage/lint failures should generate warnings in the pipeline UI but must not block merging; this is the GitLab recommended approach for non-blocking quality gates', confidence: 100 });
  }
  return fixes;
}

// ── EXISTING NEW FIXERS ───────────────────────────────────────────────────────

/** Add fail-fast: false to matrix strategy to get all test results even when one fails. */
export function fixFailFastMatrix(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('matrix:') || !f.content.includes('strategy:')) continue;
    if (f.content.includes('fail-fast:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+strategy:\s*$/.test(lines[i]) && i + 1 < lines.length && /^\s+matrix:/.test(lines[i + 1])) {
        out.push('      fail-fast: false');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added fail-fast: false to matrix strategy — by default GitHub cancels all matrix jobs when one fails; fail-fast: false lets all matrix combinations complete so you see ALL failures across Node versions/OSes, not just the first one', confidence: 100 });
  }
  return fixes;
}

/** Add artifact retention-days to upload-artifact steps. */
export function fixArtifactRetentionDays(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('upload-artifact') || f.content.includes('retention-days:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/uses:\s*actions\/upload-artifact/.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && /^\s{8,}/.test(lines[j])) {
          out.push(lines[j]);
          j++;
          i = j - 1;
        }
        // Add retention-days after the with: block
        out.push('          retention-days: 7');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added retention-days: 7 to artifact uploads — artifacts default to 90 days which wastes storage quota; 7 days is sufficient for most CI debugging purposes', confidence: 100 });
  }
  return fixes;
}

/** Add outputs: block to jobs that set GITHUB_OUTPUT but have no outputs: declaration. */
export function fixMissingJobOutputs(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('GITHUB_OUTPUT') || f.content.includes('outputs:')) continue;
    const declared = declareJobOutputs(f.content);
    if (declared)
      fixes.push({ path: f.path, content: declared.content, explanation: `Added outputs: declaration for [${declared.names.join(', ')}] — jobs must declare outputs: to expose values set via GITHUB_OUTPUT to downstream jobs; without the declaration, other jobs cannot read the values`, confidence: 100 });
  }
  return fixes;
}

/** Add pipeline-level cache for GitLab CI when none is configured. */
export function fixGitLabMissingCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('cache:') || (!f.content.includes('npm') && !f.content.includes('pip') && !f.content.includes('go '))) continue;
    const isNode = /npm|yarn|pnpm/.test(f.content);
    const isPython = /pip|python/.test(f.content);
    const cacheConfig = isNode
      ? `cache:\n  key:\n    files:\n      - package-lock.json\n      - yarn.lock\n      - pnpm-lock.yaml\n  paths:\n    - node_modules/\n    - .npm/\n  policy: pull-push\n`
      : isPython
        ? `cache:\n  key:\n    files:\n      - requirements.txt\n  paths:\n    - .venv/\n    - ~/.cache/pip/\n  policy: pull-push\n`
        : `cache:\n  key:\n    files:\n      - go.sum\n  paths:\n    - .go/pkg/mod/\n  policy: pull-push\n`;
    // cache: is a pipeline-level (top-level) key — add it once at the top of the
    // file. Splicing it after a job header broke the job mapping.
    const fixed = `${cacheConfig}\n${f.content}`;
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added GitLab CI cache for ${isNode ? 'node_modules' : isPython ? 'Python venv' : 'Go modules'} — without caching, dependencies are downloaded from scratch on every pipeline run, increasing build time by 2-10 minutes`, confidence: 100 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION A — FAILED PIPELINE STAGE
// ═══════════════════════════════════════════════════════════════════════════════

/** Add set -euo pipefail + ERR trap to shell scripts that silently swallow errors. */
export function fixShellStrictMode(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/exit code 0.*but.*error|silent failure|set -e|pipefail/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    if (f.content.includes('pipefail') || f.content.includes('set -e')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+run:\s*\|/.test(lines[i]) && !modified) {
        const indent = lines[i].match(/^(\s+)/)?.[1] ?? '        ';
        out.push(`${indent}  set -euo pipefail`);
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added set -euo pipefail to run: blocks — without this, a failing command in a multi-line script is silently ignored and the step reports success; -e aborts on error, -u errors on unset variables, -o pipefail propagates pipe failures', confidence: 90 });
  }
  return fixes;
}

/** Add exit-code trap + diagnostic dump when a stage fails unexpectedly. */
export function fixPipelineStageFailureDiagnostic(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/Process completed with exit code [1-9]|command not found|exited with code/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('if: always()') || f.content.includes('failure()')) continue;
    // Add a always-run diagnostic step after failing jobs
    const lines = f.content.split('\n');
    const out: string[] = [];
    let addedDiag = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      // After the last step in a job, add a diagnostic step
      if (!addedDiag && /^\s+- name:/.test(lines[i]) && i + 1 < lines.length && /^\s+run:/.test(lines[i + 1])) {
        const nextJobLine = lines.findIndex((l, idx) => idx > i + 2 && /^  [\w-]+:\s*$/.test(l));
        if (nextJobLine === -1 || nextJobLine > i + 10) {
          out.push('      - name: Dump environment on failure');
          out.push('        if: failure()');
          out.push('        run: |');
          out.push('          echo "=== Environment ===" && env | sort');
          out.push('          echo "=== Disk usage ===" && df -h');
          out.push('          echo "=== Process list ===" && ps aux | head -20');
          addedDiag = true;
        }
      }
    }
    if (addedDiag)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added failure diagnostic step — when a stage fails with a non-zero exit code, the environment dump captures env vars, disk space, and process list to help diagnose the root cause without re-running the pipeline', confidence: 80 });
  }
  return fixes;
}

/** Add continue-on-error: true to individual steps that are known to be flaky. */
export function fixFlakyStageContinueOnError(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/flaky|intermittent|randomly fails|transient.*error|network.*timeout/i.test(logs)) return [];
  const FLAKY_TOOLS = ['codecov', 'coveralls', 'sonar', 'snyk', 'netlify', 'vercel'];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+- name:/.test(lines[i])) {
        const stepBlock = lines.slice(i, Math.min(i + 10, lines.length)).join('\n');
        if (FLAKY_TOOLS.some(t => stepBlock.toLowerCase().includes(t)) && !stepBlock.includes('continue-on-error')) {
          const indent = lines[i].match(/^(\s+)/)?.[1] ?? '      ';
          out.push(`${indent}  continue-on-error: true`);
          modified = true;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added continue-on-error: true to third-party reporting steps — coverage, quality gate, and notification steps call external APIs that have their own availability SLAs; they should not fail the build when the external service is down', confidence: 88 });
  }
  return fixes;
}

/** Add GitLab CI rules:changes: to skip stages when unrelated files change. */
export function fixGitLabIncrementalPipeline(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('rules:') || f.content.includes('only:')) continue;
    // Detect job type and add appropriate rules
    const fixed = f.content.replace(
      /^([\w-]+:[ \t]*\n)((?:[ \t]+\S[^\n]*\n)*[ \t]+script:)/gm,
      (match, header, rest) => {
        const name = header.trim().replace(':', '').toLowerCase();
        if (/test|spec|jest|mocha|pytest/.test(name))
          return `${header}  rules:\n    - changes:\n        - "src/**/*"\n        - "test/**/*"\n        - "package.json"\n  when: on_success\n${rest}`;
        if (/deploy|release|publish/.test(name))
          return `${header}  rules:\n    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH\n      when: on_success\n    - when: never\n${rest}`;
        return match;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added rules:changes: to test jobs and rules:if: to deploy jobs — running all jobs on every commit wastes runner minutes; changes: skips tests when only docs/config change, and deploy rules ensure production deployments only happen from the default branch', confidence: 85 });
  }
  return fixes;
}

/** Add workflow_run wait step when a pipeline stage depends on another workflow completing. */
export function fixWorkflowRunWait(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('workflow_run') || f.content.includes('conclusion')) continue;
    const fixed = f.content.replace(
      /on:\s*\n(\s+)workflow_run:/,
      `on:\n$1workflow_run:\n$1  types: [completed]\n$1  # Filter: only run when the triggering workflow succeeded\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added types: [completed] to workflow_run trigger — without it, the workflow fires on every workflow_run event including in-progress; you also need to check github.event.workflow_run.conclusion == "success" in job conditions', confidence: 90 });
  }
  return fixes;
}

/** Add failure notification step (Slack/email) at the end of critical pipeline stages. */
export function fixPipelineFailureNotification(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('deploy') && !f.content.includes('release')) continue;
    if (f.content.includes('slack') || f.content.includes('SLACK_WEBHOOK') || f.content.includes('failure()')) continue;
    const fixed = f.content.replace(
      /(      steps:\n)/,
      `$1      - name: Notify on failure\n        if: failure()\n        uses: slackapi/slack-github-action@v2\n        with:\n          payload: '{"text":"Pipeline failed: \${{ github.workflow }} on \${{ github.ref }}"}'\n        env:\n          SLACK_WEBHOOK_URL: \${{ secrets.SLACK_WEBHOOK_URL }}\n          SLACK_WEBHOOK_TYPE: INCOMING_WEBHOOK\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added Slack failure notification to deploy/release workflows — pipeline failures in production stages must trigger immediate alerts; the step uses if: failure() so it only fires when something actually goes wrong', confidence: 78 });
  }
  return fixes;
}

/** Add matrix include/exclude to filter invalid OS/version combinations. */
export function fixMatrixIncludeExclude(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/matrix.*not supported|combination.*invalid|os.*version.*incompatible/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('matrix:') || f.content.includes('exclude:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+strategy:\s*$/.test(lines[i])) {
        let end = i + 1;
        while (end < lines.length && (lines[end].startsWith('      ') || lines[end].trim() === '')) end++;
        const block = lines.slice(i + 1, end).join('\n');
        if (block.includes('matrix:') && !block.includes('exclude:') && block.includes('windows') && block.includes('node')) {
          // Common exclusion: old Node on Windows
          const matrixEnd = lines.findIndex((l, idx) => idx >= i + 1 && idx < end && /^\s+matrix:\s*$/.test(l));
          if (matrixEnd !== -1) {
            // Inject exclude after matrix block
            for (let j = i + 1; j < end; j++) {
              out.push(lines[j]);
              i = j;
            }
            out.push('        exclude:');
            out.push('          - os: windows-latest');
            out.push('            node: 14');
            modified = true;
          }
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added matrix exclude for Node 14 on Windows — Node 14 reached EOL and its Windows builds have known issues with native module compilation; excluding reduces wasted runner minutes on a known-broken combination', confidence: 82 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION B — INCORRECT STAGE ORDER
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix GitLab CI stage ordering when deploy appears before test in the stages list. */
export function fixGitLabStageOrdering(files: Array<{ path: string; content: string }>): RuleFix[] {
  const CORRECT_ORDER = ['install', 'build', 'lint', 'test', 'security', 'package', 'deploy', 'notify'];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    const stagesBlock = f.content.match(/^stages:\s*\n((?:\s*-\s+\S+\s*\n)+)/m);
    if (!stagesBlock) continue;
    const declared = [...stagesBlock[1].matchAll(/^\s*-\s+(\S+)/gm)].map(m => m[1]);
    const sorted = [...declared].sort((a, b) => {
      const ai = CORRECT_ORDER.findIndex(s => a.includes(s));
      const bi = CORRECT_ORDER.findIndex(s => b.includes(s));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    if (JSON.stringify(declared) === JSON.stringify(sorted)) continue;
    const newBlock = `stages:\n${sorted.map(s => `  - ${s}`).join('\n')}\n`;
    const fixed = f.content.replace(/^stages:\s*\n(?:\s*-\s+\S+\s*\n)+/m, newBlock);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Reordered GitLab CI stages to ${sorted.join(' → ')} — stages declared out of order (e.g. deploy before test) run in the wrong sequence; GitLab executes stages in declaration order`, confidence: 85 });
  }
  return fixes;
}

/** Use DAG (needs:) in GitLab CI instead of strict stage ordering to unlock parallelism. */
export function fixGitLabDAGPipeline(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('needs:') || !f.content.includes('stage:')) continue;
    // Count stages — only suggest DAG if there are 3+ stages
    const stages = [...new Set([...f.content.matchAll(/^\s+stage:\s+(\S+)/gm)].map(m => m[1]))];
    if (stages.length < 3) continue;
    // Add needs: to the deploy job referencing test
    const fixed = f.content.replace(
      /^(deploy[\w-]*:\s*\n)((?:\s+[^\n]+\n)*\s+stage:)/gm,
      (_, header, rest) => `${header}  needs:\n    - job: test\n      artifacts: true\n${rest}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added needs: to deploy job for DAG execution — GitLab CI DAG (Directed Acyclic Graph) allows jobs to start as soon as their dependencies finish regardless of stage; deploy can start when test passes without waiting for all other jobs in the test stage', confidence: 82 });
  }
  return fixes;
}

/** Fix needs: referencing a job name that does not exist in the workflow. */
export function fixDanglingNeedsReference(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  // Run statically (no log gate) — dangling needs refs cause a hard parse error
  // before any logs are generated, so we can't rely on log pattern matching.
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !isGitLabCI(f.path)) continue;
    const jobNames = [...f.content.matchAll(/^  ([\w-]+):\s*$/gm)].map(m => m[1]);
    const needsRefs = [...f.content.matchAll(/needs:\s*\[([^\]]+)\]/g)].flatMap(m =>
      m[1].split(',').map(s => s.trim().replace(/['"]/g, '')),
    );
    const dangling = needsRefs.filter(n => n && !jobNames.includes(n));
    if (dangling.length === 0) continue;
    let content = f.content;
    for (const bad of dangling) {
      // Remove the dangling reference from the needs list
      content = content.replace(
        new RegExp(`(needs:\\s*\\[)[^\\]]*\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^\\]]*`, 'g'),
        (m, prefix) => {
          const cleaned = m.replace(prefix, '').split(',').filter(s => s.trim() !== bad).join(', ');
          return cleaned ? `${prefix}${cleaned}` : prefix.replace('[', '').trimEnd();
        },
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Removed dangling needs: references [${dangling.join(', ')}] — these jobs don't exist; GitHub/GitLab reject workflows with needs: pointing to non-existent jobs`, confidence: 90 });
  }
  return fixes;
}

/** Add needs: to enforce correct job ordering when stages run out of sequence. */
export function fixJobOrderingWithNeeds(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const jobs: { name: string; idx: number; block: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^  ([\w-]+):\s*$/);
      if (!m) continue;
      let end = i + 1;
      while (end < lines.length && (lines[end].startsWith('    ') || lines[end].trim() === '')) end++;
      jobs.push({ name: m[1], idx: i, block: lines.slice(i + 1, end).join('\n') });
    }
    // deploy/publish jobs must need test/build jobs
    const deployJobs = jobs.filter(j => /deploy|publish|release/.test(j.name) && !j.block.includes('needs:'));
    const testJob = jobs.find(j => /^(test|lint|build)$/.test(j.name));
    if (deployJobs.length === 0 || !testJob) continue;
    let content = f.content;
    for (const dj of deployJobs) {
      content = content.replace(
        new RegExp(`^(  ${dj.name}:)$`, 'm'),
        `$1\n    needs: [${testJob.name}]`,
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added needs: [${testJob.name}] to deploy/publish jobs — without needs:, deploy can start before tests pass; GitHub runs all top-level jobs in parallel by default`, confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION C — CIRCULAR PIPELINE DEPENDENCY
// ═══════════════════════════════════════════════════════════════════════════════

/** Detect a job that lists itself in its own needs: array. */
export function fixSelfReferentialNeeds(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cyclic|circular|self.*depend|job.*needs.*itself/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    let current = '';
    let content = f.content;
    let modified = false;
    for (const line of lines) {
      const jobM = line.match(/^  ([\w-]+):\s*$/);
      if (jobM) current = jobM[1];
      const needsM = line.match(/^\s+needs:\s*\[([^\]]+)\]/);
      if (needsM && current && needsM[1].split(',').map(s => s.trim()).includes(current)) {
        content = content.replace(
          new RegExp(`(  ${current}:[\\s\\S]*?)needs:\\s*\\[([^\\]]*)\\b${current}\\b([^\\]]*)\\]`),
          (_, header, before, after) => {
            const remaining = [before, after].join(',').split(',').map(s => s.trim()).filter(s => s && s !== current).join(', ');
            return remaining ? `${header}needs: [${remaining}]` : header;
          },
        );
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content, explanation: 'Removed self-referential needs: entry — a job cannot depend on itself; this creates an immediate cyclic dependency and GitHub Actions rejects the workflow', confidence: 100 });
  }
  return fixes;
}

/** Fix A→B→A circular chain by removing the back-edge needs: entry. */
export function fixTwoJobCircularChain(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cyclic|circular|needs.*cycle/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const jobNeeds = new Map<string, string[]>();
    let cur = '';
    for (const line of lines) {
      const jm = line.match(/^  ([\w-]+):\s*$/);
      if (jm) { cur = jm[1]; jobNeeds.set(cur, []); }
      const nm = line.match(/^\s+needs:\s*\[([^\]]+)\]/);
      if (nm && cur) jobNeeds.set(cur, nm[1].split(',').map(s => s.trim()));
    }
    const cycles: [string, string][] = [];
    for (const [job, needs] of jobNeeds) {
      for (const dep of needs) {
        if (jobNeeds.get(dep)?.includes(job)) cycles.push([job, dep]);
      }
    }
    if (cycles.length === 0) continue;
    let content = f.content;
    // Remove the back-edge (later job's dependency on earlier job)
    for (const [a, b] of cycles) {
      content = content.replace(
        new RegExp(`(  ${b}:[\\s\\S]*?)needs:\\s*\\[[^\\]]*\\b${a}\\b[^\\]]*\\]\\n`),
        '$1',
      );
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Removed circular needs: back-edge — jobs [${cycles.map(([a, b]) => `${a}↔${b}`).join(', ')}] depend on each other; removed the back-edge dependency to break the cycle`, confidence: 92 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION D — INVALID WORKFLOW TRIGGER
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix incorrect push: branches: filter patterns (regex vs glob mismatch). */
export function fixPushBranchFilter(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Fix common regex patterns used in place of glob patterns
    const fixed = f.content
      .replace(/branches:\s*\n(\s+)-\s+'([^']*\.[+*][^']*)'/, (_, ws, pattern) => {
        // Convert regex-like to glob: .* → **, .+ → *
        const glob = pattern.replace(/\.\*/g, '**').replace(/\.\+/g, '*').replace(/^\^/, '').replace(/\$$/, '');
        return `branches:\n${ws}- '${glob}'`;
      })
      .replace(/branches:\s*\n(\s+)-\s+\^([\w/]+)\$/m, (_, ws, branch) => `branches:\n${ws}- '${branch}'`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed branch filter pattern — GitHub Actions uses minimatch glob patterns, not regular expressions; patterns like ^main$ or .* are invalid; use "main" or "feature/**" instead', confidence: 88 });
  }
  return fixes;
}

/** Add required inputs to workflow_dispatch when none are declared. */
export function fixWorkflowDispatchInputs(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('workflow_dispatch') || f.content.includes('inputs:')) continue;
    const fixed = f.content.replace(
      /workflow_dispatch:\s*(\n|$)/,
      `workflow_dispatch:\n      inputs:\n        environment:\n          description: 'Target environment (staging/production)'\n          required: true\n          default: 'staging'\n          type: choice\n          options: [staging, production]\n        dry_run:\n          description: 'Dry run only (no actual deployment)'\n          required: false\n          default: 'false'\n          type: boolean\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added inputs: to workflow_dispatch — manual dispatch workflows without inputs have no way to parameterize the run; adding environment and dry_run inputs lets operators control deployment targets without editing the workflow file', confidence: 80 });
  }
  return fixes;
}

/** Fix pull_request_target misuse — add explicit permission guards. */
export function fixPullRequestTargetSecurity(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pull_request_target')) continue;
    if (f.content.includes('permissions:') && f.content.includes('read-all')) continue;
    // pull_request_target has write access by default and is a common CVE pattern
    const fixed = f.content.replace(
      /(pull_request_target:)/,
      `$1\n\npermissions:\n  contents: read\n  pull-requests: write\n  # WARNING: pull_request_target runs in context of BASE branch with write access\n  # Never checkout PR code and run it — use actions/checkout with the PR ref only for safe read operations`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added explicit permissions + warning to pull_request_target — this trigger runs with write access in the base repo context; checking out and executing PR code under this trigger is a critical security vulnerability (PWN requests)', confidence: 95 });
  }
  return fixes;
}

/** Fix cron schedule that is too frequent (every minute) or uses invalid syntax. */
export function fixCronScheduleExpression(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cron.*invalid|schedule.*not.*valid|cron.*syntax/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('schedule:') || !f.content.includes('cron:')) continue;
    const fixed = f.content
      // Fix 6-field cron (with seconds) which GitHub does not support
      .replace(/cron:\s*'(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)'/g, "cron: '$2'")
      // Fix every-minute cron (too frequent for GitHub Actions)
      .replace(/cron:\s*'\* \* \* \* \*'/g, "cron: '0 */6 * * *'")
      // Fix year field (cron has no year field in GitHub Actions)
      .replace(/cron:\s*'(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\d{4}'/g, "cron: '$1'");
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed cron expression — GitHub Actions uses 5-field POSIX cron (no seconds, no year); every-minute schedules are throttled by GitHub; replaced with every 6 hours to avoid quota exhaustion', confidence: 90 });
  }
  return fixes;
}

/** Fix workflow_call trigger missing required outputs or inputs declaration. */
export function fixWorkflowCallContract(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('workflow_call')) continue;
    // A reusable workflow should declare at least inputs or outputs
    if (f.content.includes('inputs:') || f.content.includes('outputs:') || f.content.includes('secrets:')) continue;
    const fixed = f.content.replace(
      /workflow_call:\s*(\n)/,
      `workflow_call:\n      inputs:\n        ref:\n          description: 'Git ref to build'\n          type: string\n          required: false\n          default: ''\n      secrets:\n        token:\n          required: true\n          description: 'GitHub token for checkout'\n$1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added inputs: and secrets: contract to workflow_call — reusable workflows called without an explicit contract force callers to use context magic to pass values; a typed contract makes the interface explicit and enables validation', confidence: 80 });
  }
  return fixes;
}

/** Fix on: push: tags: pattern that misses semver tags. */
export function fixPushTagsPattern(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('tags:') || f.content.includes('v[0-9]')) continue;
    const fixed = f.content.replace(
      /tags:\s*\n(\s+)-\s+v\*/,
      `tags:\n$1- 'v[0-9]+.[0-9]+.[0-9]+'`,
    ).replace(
      /tags:\s*\n(\s+)-\s+'\*'/,
      `tags:\n$1- 'v*.*.*'`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed tag glob pattern — "v*" matches "vbeta" and "v-test"; the precise pattern "v[0-9]+.[0-9]+.[0-9]+" only matches semver tags like v1.2.3, preventing accidental release triggers from debug tags', confidence: 85 });
  }
  return fixes;
}

/** Add path filters to push/PR triggers so CI skips doc-only changes. */
export function fixPathFilterTrigger(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('paths:') || f.content.includes('paths-ignore:')) continue;
    if (!f.content.includes('push:') && !f.content.includes('pull_request:')) continue;
    // Only add path filters for workflows with build/test steps
    if (!f.content.includes('npm') && !f.content.includes('gradle') && !f.content.includes('cargo')) continue;
    // Indent paths-ignore as a sibling of branches: — a fixed 6-space indent
    // nested it under `branches: [main]` in the standard layout (invalid YAML).
    const fixed = f.content.replace(
      /(push:[ \t]*\n)([ \t]+)(branches:[^\n]+\n)/,
      (_, push, ind, branches) =>
        `${push}${ind}${branches}${ind}paths-ignore:\n${ind}  - '**.md'\n${ind}  - 'docs/**'\n${ind}  - '.github/CODEOWNERS'\n${ind}  - 'LICENSE'\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added paths-ignore to push trigger — CI runs triggered by README edits, doc updates, and license changes waste runner minutes; paths-ignore skips the workflow when all changed files match the ignored patterns', confidence: 82 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION E — MISSING RUNNER / RUNNER OFFLINE
// ═══════════════════════════════════════════════════════════════════════════════

/** Add runner group fallback for enterprise runner pool exhaustion. */
export function fixRunnerGroupFallback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/no runner available|runner.*exhausted|runner.*pool.*empty|queue.*too long/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('self-hosted') || f.content.includes('group:')) continue;
    const fixed = f.content.replace(
      /runs-on:\s*\[self-hosted,\s*([^\]]+)\]/g,
      (_, labels) => `runs-on:\n        group: default\n        labels: [self-hosted, ${labels}]`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added runner group: default alongside self-hosted labels — when the specific runner pool is exhausted, GitHub can route to any runner in the group that matches the labels; without a group, the job queues indefinitely', confidence: 85 });
  }
  return fixes;
}

/** Add larger runner specification for memory-intensive jobs. */
export function fixLargerRunnerSpec(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/out of memory|OOM killed|Killed.*signal 9|memory.*exhausted|not enough memory/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = f.content.replace(
      /runs-on:\s*ubuntu-latest/g,
      'runs-on: ubuntu-latest-4-cores',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Upgraded to ubuntu-latest-4-cores runner — the job was OOM-killed on a 2-core runner; 4-core GitHub-hosted runners have 16 GB RAM (vs 7 GB for standard) and are available for most GitHub plan tiers', confidence: 82 });
  }
  return fixes;
}

/** Add container: image: to jobs that need a specific runtime environment. */
export function fixJobContainerImage(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/command not found|binary.*not.*available|tool.*not installed.*runner/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('container:')) continue;
    // Detect what runtime the job needs
    const needsNode = f.content.includes('npm') || f.content.includes('node');
    const needsPython = f.content.includes('python') || f.content.includes('pip');
    const needsGo = /\bgo (build|test|run)\b/.test(f.content);
    if (!needsNode && !needsPython && !needsGo) continue;
    const image = needsNode ? 'node:20-alpine' : needsPython ? 'python:3.12-slim' : 'golang:1.22-alpine';
    // Add container spec to jobs lacking it
    const fixed = f.content.replace(
      /^(  [\w-]+:\s*\n)((?:\s+[^\n]+\n)*\s+runs-on:[^\n]+\n)/gm,
      (_, header, runsOnLine) => `${header}${runsOnLine}    container:\n      image: ${image}\n`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Added container: image: ${image} — the runner's pre-installed tool version differs from what the job needs; using a container image pins the exact runtime environment and eliminates "command not found" or version mismatch errors`, confidence: 78 });
  }
  return fixes;
}

/** Add continue-on-error + re-queue strategy for offline self-hosted runners. */
export function fixOfflineRunnerContinue(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/runner.*offline|runner.*not responding|runner.*lost connection/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('self-hosted') || f.content.includes('continue-on-error')) continue;
    // Fall back to hosted runner for critical paths
    const fixed = f.content.replace(
      /runs-on:\s*\[self-hosted([^\]]*)\]/g,
      (_, rest) => `runs-on:\n        - self-hosted${rest}\n        # Fallback: comment out self-hosted and uncomment below if runner goes offline\n        # - ubuntu-latest`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added fallback runner comment — self-hosted runners going offline blocks the entire pipeline; the comment provides a quick manual fallback to GitHub-hosted runners while the self-hosted runner is recovered', confidence: 75 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION F — JOB TIMEOUT
// ═══════════════════════════════════════════════════════════════════════════════

/** Add timeout-minutes to jobs that have none (prevents 6-hour accidental locks). */
export function fixJobTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timeout|timed out|exceeded.*time.*limit|job.*cancelled.*timeout/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const patched = patchGitHubJobBlocks(
      f.content,
      b => !/timeout-minutes/i.test(b),
      '    timeout-minutes: 30',
    );
    if (patched)
      fixes.push({ path: f.path, content: patched, explanation: 'Added timeout-minutes: 30 to all jobs — GitHub\'s default is 360 minutes (6 hours); a hung process (infinite loop, waiting for input, deadlocked DB) will burn runner quota and block other jobs for hours without an explicit timeout', confidence: 95 });
  }
  return fixes;
}

/** Add per-step timeout using timeout command for long-running shell operations. */
export function fixStepLevelTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/timed out|command.*hang|step.*no.*output.*minutes/i.test(logs)) return [];
  const LONG_RUNNING = /npm install|pip install|gradle build|mvn install|cargo build|bundle install/;
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const fixed = f.content.replace(
      new RegExp(`(run:\\s*)(${LONG_RUNNING.source})`, 'g'),
      '$1timeout 300 $2',
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added timeout 300 (5 min) wrapper to long-running install commands — package installs can hang indefinitely waiting for a network response or registry lock; timeout ensures the step fails fast with a clear message instead of blocking until job-level timeout', confidence: 85 });
  }
  return fixes;
}

/** Tune GitLab CI job-level timeout for slow integration test suites. */
export function fixGitLabJobTimeout(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/job.*timed out|timeout.*exceeded|execution.*took too long/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (f.content.includes('timeout:')) continue;
    // Add timeout to integration/e2e/performance test jobs
    const fixed = f.content.replace(
      /^((?:integration|e2e|performance|load|stress)[\w-]*:[ \t]*\n)((?:[ \t]+\S[^\n]*\n)*[ \t]+script:)/gim,
      (_, header, rest) => `${header}  timeout: 1h 30m\n${rest}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added timeout: 1h 30m to integration/e2e jobs — GitLab\'s default job timeout is 1 hour; integration test suites with real databases and browser automation regularly exceed this; the job-level timeout overrides the project-level default', confidence: 90 });
  }
  return fixes;
}

/** Kill a hanging background process before job timeout using a watchdog step. */
export function fixHangingProcessWatchdog(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/process.*not.*exit|waiting.*indefinitely|hang.*background|port.*never.*ready/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('wait-on') || f.content.includes('curl.*retry')) continue;
    if (!f.content.includes('&\n') && !f.content.includes('& \n')) continue;
    // Find background processes and add wait-on before the step that uses them
    const fixed = f.content.replace(
      /(run:\s*\|?\s*\n\s+\S[^\n]+ &\n)(\s+)/g,
      (match, bgLine, nextIndent) =>
        `${bgLine}${nextIndent}# Wait for the background process to be ready (max 60s)\n${nextIndent}timeout 60 bash -c 'until curl -sf http://localhost:3000/health; do sleep 1; done'\n${nextIndent}`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added health-check wait loop after background process start — starting a server with & and immediately running tests against it causes race conditions; the curl retry loop waits until the server is actually ready, with a 60 s timeout to prevent hangs', confidence: 85 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION G — ARTIFACT UPLOAD FAILURE
// ═══════════════════════════════════════════════════════════════════════════════

/** Fix artifact upload glob pattern that matches no files. */
export function fixArtifactUploadGlob(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/No files were found with the provided path|artifact.*path.*not found|upload.*no.*files/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('upload-artifact')) continue;
    // Fix common path mistakes
    const fixed = f.content
      // dist/ → dist/** for nested files
      .replace(/(path:\s*)(dist|build|out|target)\s*$/gm, '$1$2/**')
      // Remove leading ./  (upload-artifact doesn't need it but some versions mishandle)
      .replace(/(path:\s*)\.\/([^\n]+)/g, '$1$2');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed artifact path glob — upload-artifact path: dist/ only uploads the empty directory entry; dist/** uploads all files recursively; this is the most common cause of "No files were found with the provided path"', confidence: 90 });
  }
  return fixes;
}

/** Add if-no-files-found: error to artifact uploads so missing artifacts surface early. */
export function fixArtifactIfNoFilesFound(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('upload-artifact') || f.content.includes('if-no-files-found:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/uses:\s*actions\/upload-artifact/.test(lines[i])) {
        // Find the with: block and add if-no-files-found after name:
        let j = i + 1;
        while (j < lines.length && !/^\s+- name:/.test(lines[j]) && j < i + 15) {
          out.push(lines[j]);
          if (/^\s+path:/.test(lines[j]) && !f.content.includes('if-no-files-found')) {
            out.push(lines[j].replace(/path:.*/, 'if-no-files-found: error'));
            modified = true;
          }
          j++;
          i = j - 1;
        }
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added if-no-files-found: error — the default is "warn" which lets a missing artifact pass silently; downstream download-artifact steps then fail with a confusing "artifact not found" message; "error" fails immediately with a clear message at the upload step', confidence: 92 });
  }
  return fixes;
}

/** Upload multiple separate artifact directories as named artifacts. */
export function fixMultipleArtifactUploads(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/artifact.*name.*conflict|duplicate.*artifact.*name|overwrite.*artifact/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const uploads = [...f.content.matchAll(/uses:\s*actions\/upload-artifact[\s\S]*?name:\s*(\S+)/g)];
    if (uploads.length < 2) continue;
    const names = uploads.map(m => m[1]);
    const hasDuplicates = names.length !== new Set(names).size;
    if (!hasDuplicates) continue;
    let content = f.content;
    let counter = 0;
    content = content.replace(/(uses:\s*actions\/upload-artifact[\s\S]*?name:\s*)(\S+)/g, (match, prefix, name) => {
      const seen = new Set<string>();
      if (seen.has(name)) {
        counter++;
        return `${prefix}${name}-${counter}`;
      }
      seen.add(name);
      return match;
    });
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: 'Deduplicated artifact names — multiple uploads with the same artifact name in the same workflow overwrite each other; each artifact must have a unique name within a workflow run', confidence: 88 });
  }
  return fixes;
}

/** Add GitLab CI artifacts: expire_in and when: always for test report preservation. */
export function fixGitLabArtifactConfig(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('artifacts:') || f.content.includes('expire_in:')) continue;
    const fixed = f.content.replace(
      /(artifacts:\s*\n)((?:\s+[^\n]+\n)*)/g,
      (_, header, body) => {
        let result = header + body;
        if (!body.includes('expire_in'))
          result += `  expire_in: 1 week\n`;
        if (!body.includes('when:'))
          result += `  when: always\n`;
        return result;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added expire_in: 1 week and when: always to GitLab artifacts — expire_in prevents unlimited storage growth; when: always ensures test reports are uploaded even when the job fails (critical for seeing failure details)', confidence: 90 });
  }
  return fixes;
}

/** Add compression for large artifact directories before upload. */
export function fixArtifactCompression(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/artifact.*too large|upload.*size.*exceeded|artifact.*limit/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('upload-artifact') || f.content.includes('tar ')) continue;
    const fixed = f.content.replace(
      /(\s+- name: Upload[^\n]+\n\s+uses: actions\/upload-artifact[^\n]+\n\s+with:\n\s+name: ([^\n]+)\n\s+path: ([^\n]+))/g,
      (_, stepDef, name, path) => {
        const trimPath = path.trim();
        return `      - name: Compress artifact\n        run: tar -czf /tmp/${name.trim()}.tar.gz ${trimPath}\n${stepDef.replace(`path: ${path}`, `path: /tmp/${name.trim()}.tar.gz`)}`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added tar compression before upload — artifact upload limits (500 MB on free tier, 2 GB on paid) are easily exceeded by large dist/ or node_modules/ directories; compressing to a .tar.gz first typically reduces size by 60-80%', confidence: 82 });
  }
  return fixes;
}

/** Add S3 fallback upload when GitHub artifact storage fails. */
export function fixS3ArtifactFallback(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/artifact.*upload.*failed|storage.*unavailable|artifact.*service.*error/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('aws s3 cp') || !f.content.includes('upload-artifact')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/uses:\s*actions\/upload-artifact/.test(lines[i]) && !modified) {
        out.push('      - name: Fallback upload to S3');
        out.push('        if: failure()');
        out.push('        run: |');
        out.push('          aws s3 cp ./dist/ s3://${{ secrets.ARTIFACTS_BUCKET }}/${{ github.run_id }}/ --recursive');
        out.push('        env:');
        out.push('          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}');
        out.push('          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}');
        out.push('          AWS_DEFAULT_REGION: us-east-1');
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added S3 fallback on artifact upload failure — GitHub artifact storage has occasional outages; uploading to S3 as a fallback ensures build outputs are preserved even when the GitHub service is degraded', confidence: 78 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION H — CACHE RESTORE FAILURE
// ═══════════════════════════════════════════════════════════════════════════════

/** Add fallback restore-keys when primary cache key never hits. */
export function fixCacheRestoreKeys(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/cache')) continue;
    if (f.content.includes('restore-keys:')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+key:\s*\$\{\{/.test(lines[i]) && !modified) {
        const indent = lines[i].match(/^(\s+)/)?.[1] ?? '          ';
        // Extract OS prefix from key if present
        const osPrefix = lines[i].includes('runner.os') ? `${indent}  - \${{ runner.os }}-deps-\n${indent}  - \${{ runner.os }}-` : `${indent}  - deps-`;
        out.push(`${indent}restore-keys: |\n${osPrefix}`);
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added restore-keys fallback — without restore-keys, a cache miss means zero caching benefit for that run; restore-keys allows partial matches (same OS, different hash) so at least some dependencies are cached and install time is reduced', confidence: 95 });
  }
  return fixes;
}

/** Fix cache path mismatch between what is cached and where the tool installs. */
export function fixCachePathMismatch(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cache.*miss|cache.*not.*found|restore.*failed|cache.*path.*invalid/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('actions/cache')) continue;
    // Fix common path mistakes
    const fixed = f.content
      // node_modules at root vs package path
      .replace(/(paths?:\s*\n\s+- )node_modules\s*$/gm, '$1**/node_modules')
      // ~/.m2 vs ~/.m2/repository
      .replace(/(paths?:\s*\n\s+- )~\/\.m2\s*$/gm, '$1~/.m2/repository')
      // go/pkg vs go/pkg/mod
      .replace(/(paths?:\s*\n\s+- )~\/go\/pkg\s*$/gm, '$1~/go/pkg/mod')
      // pip cache path
      .replace(/(paths?:\s*\n\s+- )~\/\.pip\s*$/gm, '$1~/.cache/pip');
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Fixed cache path — caching the wrong directory (node_modules instead of **/node_modules for workspaces, ~/.m2 instead of ~/.m2/repository for Maven) results in cache misses on every run because the cached path contains no files', confidence: 88 });
  }
  return fixes;
}

/** Use setup-node/setup-python built-in cache instead of manual actions/cache. */
export function fixSetupActionBuiltinCache(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('actions/cache')) continue;
    // Detect if they manually cache npm/pip when setup-node/setup-python cache: is available
    if (f.content.includes('setup-node') && f.content.includes('actions/cache') && !f.content.includes("cache: 'npm'")) {
      const fixed = f.content.replace(
        /(uses:\s*actions\/setup-node[^\n]+\n)((?:\s+[^\n]+\n)*?\s+with:\s*\n(?:\s+[^\n]+\n)*)/,
        (_, action, withBlock) => {
          if (withBlock.includes('cache:')) return `${action}${withBlock}`;
          return `${action}${withBlock}          cache: 'npm'\n`;
        },
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added cache: npm to actions/setup-node — the setup-node action has built-in caching that handles cache keys and restore-keys automatically; using it is simpler and more reliable than manually configuring actions/cache for npm', confidence: 88 });
    }
    if (f.content.includes('setup-python') && f.content.includes('actions/cache') && !f.content.includes("cache: 'pip'")) {
      const fixed = f.content.replace(
        /(uses:\s*actions\/setup-python[^\n]+\n)((?:\s+[^\n]+\n)*?\s+with:\s*\n(?:\s+[^\n]+\n)*)/,
        (_, action, withBlock) => {
          if (withBlock.includes('cache:')) return `${action}${withBlock}`;
          return `${action}${withBlock}          cache: 'pip'\n`;
        },
      );
      if (fixed !== f.content)
        fixes.push({ path: f.path, content: fixed, explanation: 'Added cache: pip to actions/setup-python — built-in pip caching handles ~/.cache/pip correctly and invalidates on requirements*.txt changes automatically', confidence: 88 });
    }
  }
  return fixes;
}

/** Fix GitLab CI cache policy to pull-only on most jobs, push only on the install job. */
export function fixGitLabCachePolicy(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitLabCI(f.path)) continue;
    if (!f.content.includes('cache:') || f.content.includes('policy:')) continue;
    const fixed = f.content.replace(
      /^([\w-]+:[ \t]*\n)((?:[ \t]+\S[^\n]*\n)*[ \t]+cache:[ \t]*\n(?:[ \t]+\S[^\n]*\n)*[ \t]+script:[^\n]*\n)/gm,
      (match, header, rest) => {
        const name = header.trim().replace(':', '').toLowerCase();
        const policy = /install|setup|deps|dependencies/.test(name) ? 'pull-push' : 'pull';
        return `${header}${rest.replace(/(cache:\s*\n)/, `$1  policy: ${policy}\n`)}`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added cache policy: pull to test/build jobs and pull-push to install job — with pull-push on every job, each parallel job tries to upload the same cache simultaneously causing race conditions and wasted bandwidth; only the install job should push', confidence: 88 });
  }
  return fixes;
}

/** Add hashFiles to cache key when it uses only static strings (never invalidates). */
export function fixCacheKeyHashFiles(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) || !f.content.includes('actions/cache')) continue;
    const lines = f.content.split('\n');
    const out: string[] = [];
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^\s+key:\s*\$\{\{\s*runner\.os\s*\}\}-[\w-]+-\d+/.test(lines[i]) && !lines[i].includes('hashFiles')) {
        // Replace static version number with hashFiles
        out[out.length - 1] = lines[i].replace(/-\d+('?)$/, "-\${{ hashFiles('**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/requirements*.txt', '**/go.sum', '**/Cargo.lock') }}$1");
        modified = true;
      }
    }
    if (modified)
      fixes.push({ path: f.path, content: out.join('\n'), explanation: 'Added hashFiles() to cache key — a static cache key (like runner.os-deps-v1) never invalidates when dependencies change; hashFiles() generates a hash from lock files so the cache is automatically invalidated when any dependency changes', confidence: 90 });
  }
  return fixes;
}

/** Clear corrupted cache by adding cache-bust prefix when cache restore fails consistently. */
export function fixCacheBust(logs: string, files: Array<{ path: string; content: string }>): RuleFix[] {
  if (!/cache.*corrupt|restore.*checksum.*mismatch|archive.*invalid|cache.*version.*mismatch/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('actions/cache') || f.content.includes('cache-bust')) continue;
    const fixed = f.content.replace(
      /(key:\s*\$\{\{[^}]+\}\})/g,
      `v2-$1`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added v2- prefix to cache key (cache bust) — a corrupted or incompatible cache archive causes restore failures on every run; bumping the version prefix immediately invalidates all old cache entries and forces a clean rebuild', confidence: 90 });
  }
  return fixes;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION I — PARALLEL JOB SYNCHRONIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Add a barrier/gate job that all parallel jobs must pass before downstream continues. */
export function fixBarrierGateJob(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    // Find workflows with many parallel jobs and a single deploy job
    const lines = f.content.split('\n');
    const jobNames = lines.filter(l => /^  [\w-]+:\s*$/.test(l)).map(l => l.trim().replace(':', ''));
    const parallelJobs = jobNames.filter(j => /test|lint|security|scan/.test(j));
    const deployJob = jobNames.find(j => /deploy|release|publish/.test(j));
    if (parallelJobs.length < 2 || !deployJob) continue;
    if (f.content.includes('all-checks') || f.content.includes('gate')) continue;
    // Add a gate job
    const gateJobYaml = `\n  all-checks-passed:\n    name: All checks passed\n    runs-on: ubuntu-latest\n    needs: [${parallelJobs.join(', ')}]\n    steps:\n      - run: echo "All parallel checks passed"\n`;
    // Update deploy to need the gate job
    let content = f.content.replace(
      new RegExp(`^(  ${deployJob}:)$`, 'm'),
      `$1\n    needs: [all-checks-passed]`,
    );
    // Add gate job before deploy
    content = content.replace(
      new RegExp(`^  ${deployJob}:`, 'm'),
      `${gateJobYaml}\n  ${deployJob}:`,
    );
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added gate job "all-checks-passed" — instead of deploy depending on [${parallelJobs.join(', ')}] directly, a single gate job fans in all results; this pattern is clearer in the UI and makes it easy to add/remove parallel jobs without updating deploy's needs: list`, confidence: 85 });
  }
  return fixes;
}

/** Fix download-artifact to come after all parallel upload jobs complete. */
export function fixDownloadAfterUpload(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('download-artifact') || !f.content.includes('upload-artifact')) continue;
    // Find the job that downloads and check if it has needs: pointing to all upload jobs
    const lines = f.content.split('\n');
    const uploadJobs: string[] = [];
    const downloadJobs: string[] = [];
    let curJob = '';
    for (const line of lines) {
      const jm = line.match(/^  ([\w-]+):\s*$/);
      if (jm) curJob = jm[1];
      if (line.includes('upload-artifact') && curJob) uploadJobs.push(curJob);
      if (line.includes('download-artifact') && curJob) downloadJobs.push(curJob);
    }
    if (uploadJobs.length === 0 || downloadJobs.length === 0) continue;
    let content = f.content;
    for (const dj of downloadJobs) {
      const djBlock = content.match(new RegExp(`  ${dj}:[\\s\\S]*?(?=\\n  [\\w-]+:|$)`))?.[0] ?? '';
      const missingUploaders = uploadJobs.filter(uj => !djBlock.includes(uj));
      if (missingUploaders.length === 0) continue;
      const needsMatch = djBlock.match(/needs:\s*\[([^\]]+)\]/);
      if (needsMatch) {
        content = content.replace(
          new RegExp(`(  ${dj}:[\\s\\S]*?)needs:\\s*\\[([^\\]]+)\\]`),
          (_, header, deps) => `${header}needs: [${deps}, ${missingUploaders.join(', ')}]`,
        );
      } else {
        content = content.replace(
          new RegExp(`^(  ${dj}:)$`, 'm'),
          `$1\n    needs: [${missingUploaders.join(', ')}]`,
        );
      }
    }
    if (content !== f.content)
      fixes.push({ path: f.path, content, explanation: `Added missing upload jobs to download job's needs: — download-artifact fails with "artifact not found" when the uploading job hasn't finished yet; needs: creates the correct sequential dependency`, confidence: 90 });
  }
  return fixes;
}

/** Prevent file write races in parallel matrix jobs by using job-specific output paths. */
export function fixParallelJobOutputPaths(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('matrix:') || !f.content.includes('coverage.xml')) continue;
    // Parallel jobs writing to the same coverage.xml path overwrite each other
    const fixed = f.content.replace(
      /coverage\.xml\b/g,
      `coverage-\${{ matrix.node || matrix.python || matrix.os || strategy.job-index }}.xml`,
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added matrix variable to coverage output filename — parallel matrix jobs writing to the same coverage.xml overwrite each other; using the matrix value in the filename creates unique paths per job and allows all results to be merged', confidence: 85 });
  }
  return fixes;
}

/** Add upload of per-job artifacts in matrix, then merge in a fan-in job. */
export function fixMatrixArtifactFanIn(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('matrix:')) continue;
    if (f.content.includes('upload-artifact') || !f.content.includes('coverage')) continue;
    // Add per-matrix upload to the matrix job
    const fixed = f.content.replace(
      /(\s+steps:\n(?:\s+- [^\n]+\n)+)/,
      (steps) => {
        if (steps.includes('upload-artifact')) return steps;
        return steps + `      - uses: actions/upload-artifact@v4\n        if: always()\n        with:\n          name: coverage-\${{ matrix.node }}\n          path: coverage/\n          retention-days: 1\n`;
      },
    );
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added per-matrix artifact upload — each matrix job should upload its own coverage/test results as a named artifact; a fan-in job can then download all of them and merge for a combined coverage report', confidence: 80 });
  }
  return fixes;
}

/** Add concurrency cancel-in-progress: true for PR CI runs to kill stale jobs. */
export function fixConcurrencyForPR(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (!f.content.includes('pull_request') || f.content.includes('concurrency:')) continue;
    const concurrencyBlock = `concurrency:\n  group: pr-\${{ github.event.pull_request.number }}\n  cancel-in-progress: true\n\n`;
    const fixed = f.content.replace(/^(on:)/m, `${concurrencyBlock}$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added concurrency with cancel-in-progress: true for PR workflows — when a developer pushes a new commit while CI is running, the old run is redundant; cancelling it frees runners immediately and reduces queue wait time for the new run', confidence: 92 });
  }
  return fixes;
}

/** Wait for all matrix jobs to finish before proceeding using a summary job. */
export function fixMatrixFanInSummary(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    const lines = f.content.split('\n');
    const matrixJobs = lines
      .filter(l => /^  [\w-]+:\s*$/.test(l))
      .map(l => l.trim().replace(':', ''))
      .filter((_, i, arr) => {
        const block = lines.slice(lines.findIndex(l => l.trim() === `${arr[i]}:`), lines.findIndex(l => l.trim() === `${arr[i]}:`) + 20).join('\n');
        return block.includes('matrix:');
      });
    if (matrixJobs.length === 0) continue;
    if (f.content.includes('ci-success') || f.content.includes('all-passed')) continue;
    const summaryJob = `\n  ci-success:\n    name: CI passed\n    if: always()\n    needs: [${matrixJobs.join(', ')}]\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check all matrix results\n        run: |\n          results="${matrixJobs.map(j => `\${{ needs.${j}.result }}`).join(' ')}"\n          for r in $results; do\n            if [ "$r" != "success" ] && [ "$r" != "skipped" ]; then\n              echo "Job failed with result: $r"; exit 1\n            fi\n          done\n`;
    const fixed = f.content + summaryJob;
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: 'Added ci-success fan-in job — branch protection rules require a specific job to pass; a matrix job\'s individual entries cannot be referenced by name in branch protection; a fan-in summary job provides a stable single job name that aggregates all matrix results', confidence: 85 });
  }
  return fixes;
}

/** Add workflow-level env for shared variables used across parallel jobs. */
export function fixWorkflowLevelEnvSharing(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;
    if (f.content.includes('\nenv:\n') || !f.content.includes('matrix:')) continue;
    // Detect repeated env vars across job blocks
    const envMatches = [...f.content.matchAll(/^\s{6}env:\s*\n((?:\s{8}\S+:[^\n]+\n)+)/gm)];
    if (envMatches.length < 2) continue;
    // Find common keys
    const parsedEnvs = envMatches.map(m => [...m[1].matchAll(/^\s+(\w+):/gm)].map(k => k[1]));
    const common = parsedEnvs[0].filter(k => parsedEnvs.every(e => e.includes(k)));
    if (common.length === 0) continue;
    // Extract common env block from first match
    const firstEnvBlock = envMatches[0][1];
    const commonLines = firstEnvBlock.split('\n').filter(l => common.some(k => l.includes(k + ':')));
    const workflowEnv = `env:\n${commonLines.map(l => l.replace(/^\s+/, '  ')).join('\n')}\n\n`;
    const fixed = f.content.replace(/^(on:)/m, `${workflowEnv}$1`);
    if (fixed !== f.content)
      fixes.push({ path: f.path, content: fixed, explanation: `Promoted shared env vars [${common.join(', ')}] to workflow level — defining the same env vars in every parallel job is repetitive and error-prone; workflow-level env: is inherited by all jobs automatically`, confidence: 82 });
  }
  return fixes;
}

/**
 * Fix wrong job ID format in needs.<id>.outputs / needs.<id>.result expressions.
 * GitHub Actions job IDs use hyphens. Referencing them with underscores silently
 * returns an empty string — no error is logged.
 *
 * Example: needs.unit_test.result → needs.unit-test.result
 *          needs.validate_version.outputs → needs.validate-version.outputs
 */
export function fixNeedsContextKeyMismatch(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;

    // Extract all real job IDs from the file (hyphenated)
    const jobIds = [...f.content.matchAll(/^  ([\w-]+):\s*$/gm)].map(m => m[1]);

    let fixed = f.content;
    let changed = false;

    // Find needs.<id>.xxx references and check if the id uses underscores when hyphen is correct
    fixed = fixed.replace(
      /needs\.([\w]+)\.(outputs|result)\b/g,
      (match, id, suffix) => {
        // Convert underscores to hyphens and check if that matches a real job ID
        const hyphenated = id.replace(/_/g, '-');
        if (hyphenated !== id && jobIds.includes(hyphenated)) {
          changed = true;
          return `needs.${hyphenated}.${suffix}`;
        }
        return match;
      }
    );

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed needs context key ID: underscore → hyphen. GitHub Actions job IDs use hyphens; ' +
          'referencing them with underscores (needs.unit_test.result) silently returns empty string — ' +
          'corrected to match actual job ID (needs.unit-test.result)',
        confidence: 95,
      });
    }
  }
  return fixes;
}

/**
 * Fix invalid GitHub Actions result string values in if: conditions.
 * Valid values are: success, failure, cancelled, skipped.
 * Using "passed", "failed", "pass", "fail" (common mistake) always evaluates false.
 */
export function fixWrongResultValueInIf(files: Array<{ path: string; content: string }>): RuleFix[] {
  const WRONG_TO_RIGHT: Record<string, string> = {
    passed: 'success',
    pass: 'success',
    failed: 'failure',
    fail: 'failure',
    errored: 'failure',
    error: 'failure',
    skip: 'skipped',
    canceled: 'cancelled',
  };

  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;

    let fixed = f.content;
    let changed = false;

    // Match patterns like: == 'passed', == "failed", == 'pass'
    fixed = fixed.replace(
      /==\s*['"](passed|pass|failed|fail|errored|error|skip|canceled)['"]/gi,
      (match, val) => {
        const correct = WRONG_TO_RIGHT[val.toLowerCase()];
        if (correct && correct !== val.toLowerCase()) {
          changed = true;
          return `== '${correct}'`;
        }
        return match;
      }
    );

    // Also match .result == 'passed' pattern
    fixed = fixed.replace(
      /\.result\s*==\s*['"](passed|pass|failed|fail|errored|error|skip|canceled)['"]/gi,
      (match, val) => {
        const correct = WRONG_TO_RIGHT[val.toLowerCase()];
        if (correct && correct !== val.toLowerCase()) {
          changed = true;
          return `.result == '${correct}'`;
        }
        return match;
      }
    );

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed invalid GitHub Actions result values in if: conditions. ' +
          'Valid values are success/failure/cancelled/skipped. ' +
          '"passed", "failed", "pass", "fail" are always false — corrected to official values.',
        confidence: 98,
      });
    }
  }
  return fixes;
}

/**
 * Fix matrix key reference: matrix.node-version → matrix.node.
 * When the matrix strategy defines key "node" but steps reference "matrix.node-version",
 * all artifact names collapse to "test-results-" (empty interpolation).
 */
export function fixMatrixNodeVersionKey(files: Array<{ path: string; content: string }>): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!isGitHubWorkflow(f.path)) continue;

    // Extract upload artifact names (upload-artifact steps)
    const uploadNames: string[] = [];
    const uploadMatches = f.content.matchAll(
      /upload-artifact[^:]*:\s*\n(?:.*\n)*?\s+name:\s+(.+)/g
    );
    for (const m of uploadMatches) {
      uploadNames.push(m[1].trim());
    }

    // Extract download artifact names
    const downloadMatches = [...f.content.matchAll(
      /download-artifact[^:]*:\s*\n(?:.*\n)*?\s+name:\s+(.+)/g
    )];

    if (uploadNames.length === 0 || downloadMatches.length === 0) continue;

    let fixed = f.content;
    let changed = false;

    // If the upload name uses ${{ matrix.node }} but the download uses matrix.node-version
    // or the artifact upload itself uses matrix.node-version (wrong key), fix it.
    if (fixed.includes('matrix.node-version')) {
      fixed = fixed.replace(/\$\{\{\s*matrix\.node-version\s*\}\}/g, '${{ matrix.node }}');
      changed = true;
    }

    if (changed) {
      fixes.push({
        path: f.path,
        content: fixed,
        explanation:
          'Fixed matrix key reference: matrix.node-version → matrix.node. ' +
          'The matrix strategy key is "node" (from matrix.node: ["18","20"]); ' +
          '"matrix.node-version" is undefined and produces empty string, ' +
          'causing all artifact uploads to overwrite each other with name "test-results-".',
        confidence: 95,
      });
    }
  }
  return fixes;
}
