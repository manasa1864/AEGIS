// Server-side render of the live healing UI with a realistic mid-run state:
// proves the panel and graph reflect what is being fixed (not static markup).

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { HealingProgressPanel } from '../src/app/components/HealingProgressPanel';
import { SystemGraph } from '../src/app/components/SystemGraph';
import { startRun, withFixes, applyStreamMessage, withOutcome, type HealingRun } from '../src/app/lib/healingRun';

function midRun(): HealingRun {
  let r = startRun();
  for (const m of [
    'fetching_workflow_runs :: status=failure',
    'ci_failure :: workflows=1 [CI] commit=a3f4b2c',
    '#2 :: strategy=ai_analysis model=x',
    'ERROR_DIAGNOSED :: categories=[actions_deprecation]',
  ]) r = applyStreamMessage(r, m);
  r = { ...r, categories: ['actions_deprecation', 'node_version'], failure: { workflows: ['CI'], jobs: ['build'], steps: ['Setup node'], sha: 'a3f4b2c' } };
  r = { ...withFixes(r, [{ path: '.github/workflows/ci.yml', content: 'uses: actions/checkout@v4\n', explanation: 'Upgraded checkout to v4' }], [{ path: '.github/workflows/ci.yml', content: 'uses: actions/checkout@v2\n' }], 'rule'), engine: 'rules', confidence: 95 };
  r = applyStreamMessage(r, '#3 :: strategy=create_branch name=aegis/fix-1');
  r = applyStreamMessage(r, 'fix_committed :: sha=abc path=.github/workflows/ci.yml');
  return r;
}

describe('live healing UI', () => {
  it('renders the phases, diagnosis, fix list with diff, and branch', () => {
    const html = renderToString(createElement(HealingProgressPanel, { run: midRun() }));
    for (const text of ['DIAGNOSE', 'actions_deprecation', 'node_version', '.github/workflows/ci.yml', 'COMMITTED', 'aegis/fix-1', 'actions/checkout@v4', 'deterministic rules']) {
      expect(html, text).toContain(text);
    }
    expect(html).toMatch(/95(<!-- -->)?%/); // React SSR separates adjacent text nodes
  });

  it('renders nothing before a run starts', () => {
    expect(renderToString(createElement(HealingProgressPanel, { run: { ...midRun(), startedAt: null } }))).toBe('');
  });

  it('graph halt overlay shows the real reason, not a canned message', () => {
    const run = withOutcome(midRun(), 'halted', 'all commits failed — check write permissions');
    const html = renderToString(createElement(SystemGraph, { status: 'stopped', run }));
    expect(html).toContain('all commits failed — check write permissions');
    expect(html).not.toContain('NO_PROGRESS_DETECTED');
  });
});

describe('healing strategies + new views', () => {
  it('shows the strategy ladder with what was tried and what was used', async () => {
    const { withStrategy } = await import('../src/app/lib/healingRun');
    let run = midRun();
    run = withStrategy(run, 'memory', 'skipped', 'no stored fix for this error');
    run = withStrategy(run, 'rules', 'done', '1 file(s)');
    const html = renderToString(createElement(HealingProgressPanel, { run }));
    for (const text of ['HEALING_STRATEGIES', 'KNOWN FIX', 'RULES', 'FLAKY CHECK', 'AUTO-FIXERS', 'AI', 'REVERT', 'no stored fix for this error', 'used', 'not needed']) {
      expect(html, text).toContain(text);
    }
  });

  it('settings expose the GCloud key, self-hosted GitLab host and auto-heal', async () => {
    const { SettingsModal } = await import('../src/app/components/SettingsModal');
    const html = renderToString(createElement(SettingsModal, {
      show: true, onClose: () => {}, onSave: () => {},
      current: { githubPat: '', gitlabPat: '', gitlabHost: 'gitlab.acme.io', groqKey: '', geminiKey: '', gcloudKey: '', autoHeal: true },
    }));
    for (const text of ['GCLOUD_KEY', 'GITLAB_HOST', 'gitlab.acme.io', 'AUTO_HEAL']) expect(html, text).toContain(text);
  });

  it('every page reachable from the new tabs renders', async () => {
    const pages = await Promise.all([
      import('../src/app/components/CICDPage'), import('../src/app/components/IssuesPage'),
      import('../src/app/components/PullRequestsPage'), import('../src/app/components/BranchesPage'),
      import('../src/app/components/ReleasesPage'), import('../src/app/components/SecurityPage'),
      import('../src/app/components/InsightsPage'), import('../src/app/components/PushPage'),
    ]);
    const props = {
      projects: [{ id: '1', name: 'app', errorType: 'CI_HEALTHY', repo: 'main', severity: 'low' as const, owner: 'o', repoName: 'app', platform: 'github' as const }],
      selectedProject: '1', onSelectProject: () => {}, onClearProject: () => {},
      githubPat: 'x', gitlabPat: '', geminiKey: '', groqKey: '', onAddRepo: async () => {},
    };
    for (const mod of pages) {
      const Page = Object.values(mod).find(v => typeof v === 'function') as (p: typeof props) => JSX.Element;
      expect(() => renderToString(createElement(Page, props)), Page.name).not.toThrow();
    }
  });
});
