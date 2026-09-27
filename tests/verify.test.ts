// Fix-branch verification: judge only the branch's newest commit, never count
// base-branch (pull_request_target) runs as testing the fix, and report honestly
// when CI cannot test the branch — plus the outcome the UI shows for each case.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyBranchCI } from '../src/app/lib/github';
import { applyStreamMessage, inferOutcome, startRun, type HealingRun } from '../src/app/lib/healingRun';

type Run = { id: number; name: string; head_sha: string; status: string; conclusion: string | null; event: string };

function stubGitHub(head: string, runs: Run[] | (() => Run[])) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/git/ref/heads/')) return new Response(JSON.stringify({ object: { sha: head } }));
    if (url.includes('/actions/runs')) return new Response(JSON.stringify({ workflow_runs: typeof runs === 'function' ? runs() : runs }));
    return new Response('{}', { status: 404 });
  }));
}
const fast = { pollIntervalMs: 1, maxWaitMs: 200, noCiAfterMs: 50 };

afterEach(() => vi.unstubAllGlobals());

describe('verifyBranchCI', () => {
  it('ignores failed runs of earlier commits on the branch', async () => {
    stubGitHub('new', [
      { id: 1, name: 'nightly.yml', head_sha: 'old', status: 'completed', conclusion: 'failure', event: 'push' },
      { id: 2, name: 'CI', head_sha: 'new', status: 'completed', conclusion: 'success', event: 'push' },
    ]);
    const r = await verifyBranchCI('t', 'o', 'r', 'aegis/fix-1', fast);
    expect(r.state).toBe('success');
    expect(r.runs.map(x => x.id)).toEqual([2]);
  });

  it('does not treat pull_request_target runs as testing the fix', async () => {
    stubGitHub('new', [{ id: 3, name: 'CI', head_sha: 'new', status: 'completed', conclusion: 'failure', event: 'pull_request_target' }]);
    const r = await verifyBranchCI('t', 'o', 'r', 'aegis/fix-1', fast);
    expect(r.state).toBe('untested');
    expect(r.reason).toMatch(/base branch/);
  });

  it('reports no_ci when nothing runs for the branch', async () => {
    stubGitHub('new', []);
    expect((await verifyBranchCI('t', 'o', 'r', 'aegis/fix-1', fast)).state).toBe('no_ci');
  });

  it('waits for running runs and reports progress, then judges them', async () => {
    let calls = 0;
    stubGitHub('new', () => (++calls < 3
      ? [{ id: 4, name: 'CI', head_sha: 'new', status: 'in_progress', conclusion: null, event: 'pull_request' }]
      : [{ id: 4, name: 'CI', head_sha: 'new', status: 'completed', conclusion: 'failure', event: 'pull_request' }]));
    const progress: string[] = [];
    const r = await verifyBranchCI('t', 'o', 'r', 'aegis/fix-1', { ...fast, onProgress: m => progress.push(m) });
    expect(r.state).toBe('failure');
    expect(progress[0]).toMatch(/1\/1 run\(s\) still running/);
  });
});

describe('healing outcome after the PR', () => {
  const withPr = (): HealingRun => applyStreamMessage(startRun(), 'PR_CREATED :: confidence=91%', 'https://github.com/o/r/pull/1');

  it('is HEALED only when CI is green on the fix branch', () => {
    const run = applyStreamMessage(withPr(), 'FIX_VERIFIED :: ci_green branch=aegis/fix-1');
    expect(inferOutcome(run, '').kind).toBe('healed');
  });

  it('is PARTIAL when CI is still red, and marks VERIFY failed', () => {
    const run = applyStreamMessage(withPr(), 'FIX_UNVERIFIED :: ci_red branch=aegis/fix-1 — starting deep_diagnosis_pass');
    expect(run.phases.verify).toBe('failed');
    expect(inferOutcome(run, '').kind).toBe('partial');
  });

  it('is UNVERIFIED (with the reason) when CI could not test the fix', () => {
    const run = applyStreamMessage(withPr(), 'VERIFY_INCONCLUSIVE :: only pull_request_target runs (CI)');
    const o = inferOutcome(run, '');
    expect(o.kind).toBe('unverified');
    expect(o.reason).toContain('pull_request_target');
  });
});
