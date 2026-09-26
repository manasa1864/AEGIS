// Strategy 3 — is the failure flaky? Re-run only the failed jobs; if they pass
// the second time, the code is fine and nothing should be changed.

import { rerunFailedJobs, waitForRun } from '../github';
import { retryPipeline, waitForPipeline } from '../gitlab';
import type { StrategyContext } from './types';

/** Categories whose failures are usually transient (network, quotas, runners). */
export const TRANSIENT_CATEGORIES = new Set([
  'api_timeout', 'api_rate_limit', 'runner_unavailable', 'service_unavailable',
  'third_party_failure', 'docker_rate_limit', 'cache_restore_failure',
  'artifact_upload_failure', 'image_pull_failure', 'concurrency_issue',
]);

/** True when every diagnosed category is a transient one — check flakiness before changing code. */
export const looksTransient = (categories: string[]) =>
  categories.length > 0 && categories.every(c => TRANSIENT_CATEGORIES.has(c));

export type FlakyResult = 'flaky' | 'still-failing' | 'unavailable';

export async function checkFlaky(ctx: StrategyContext, maxWaitMs = 10 * 60_000): Promise<FlakyResult> {
  const runs = ctx.failingRuns.slice(0, 5);
  if (runs.length === 0) return 'unavailable';

  const started = await Promise.all(runs.map(r =>
    ctx.platform === 'github'
      ? rerunFailedJobs(ctx.pat, ctx.owner, ctx.repo, r.id)
      : retryPipeline(ctx.pat, ctx.owner, ctx.repo, r.id),
  ));
  if (!started.some(Boolean)) return 'unavailable';
  ctx.log(`FLAKY_CHECK :: re-running failed jobs of ${started.filter(Boolean).length} run(s) — max_wait=${Math.round(maxWaitMs / 60_000)}m`, 'attempt');

  const results = await Promise.all(runs.map((r, i) => {
    if (!started[i]) return Promise.resolve('failure' as const);
    return ctx.platform === 'github'
      ? waitForRun(ctx.pat, ctx.owner, ctx.repo, r.id, maxWaitMs, 15_000, ctx.isCancelled)
      : waitForPipeline(ctx.pat, ctx.owner, ctx.repo, r.id, maxWaitMs, 15_000, ctx.isCancelled);
  }));
  if (results.every(r => r === 'success')) return 'flaky';
  if (results.some(r => r === 'timeout')) ctx.log('FLAKY_CHECK :: rerun still running — treating as a real failure', 'info');
  return 'still-failing';
}
