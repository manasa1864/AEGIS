import { describe, it, expect } from 'vitest';
import { declareJobOutputs } from '../src/app/lib/fixers/helpers';
import { fixMissingJobOutputs } from '../src/app/lib/fixers/intermediate/pipeline';
import { fixMissingJobOutputsDeclaration } from '../src/app/lib/fixers/simple/environment';
import { fixNonFastForwardPush } from '../src/app/lib/fixers/intermediate/git';
import { fixGitLabVariableScope } from '../src/app/lib/fixers/intermediate/config';
import { validateFix } from '../src/app/lib/fixValidator';
import { geminiText } from '../src/app/lib/models';
import { isFailedConclusion } from '../src/app/lib/github';

const WORKFLOW_WITH_OUTPUT = [
  'name: CI',
  'on: [push]',
  'jobs:',
  '  version:',
  '    name: Compute version',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - id: ver',
  '        run: echo "tag=v1" >> $GITHUB_OUTPUT',
  '  deploy:',
  '    needs: version',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo ${{ needs.version.outputs.tag }}',
  '',
].join('\n');

describe('declareJobOutputs', () => {
  it('references the real step id, never a placeholder', () => {
    const r = declareJobOutputs(WORKFLOW_WITH_OUTPUT);
    expect(r?.names).toEqual(['tag']);
    expect(r?.content).toContain('      tag: ${{ steps.ver.outputs.tag }}');
    expect(r?.content).not.toContain('<step-id>');
  });

  it('keeps lines between the job header and runs-on', () => {
    const r = declareJobOutputs(WORKFLOW_WITH_OUTPUT)!;
    expect(r.content).toContain('    name: Compute version');
    // every original line survives — only the outputs block is added
    for (const line of WORKFLOW_WITH_OUTPUT.split('\n')) expect(r.content.split('\n')).toContain(line);
  });

  it('declares nothing when the writing step has no id', () => {
    const noId = WORKFLOW_WITH_OUTPUT.replace('      - id: ver\n        run:', '      - run:');
    expect(declareJobOutputs(noId)).toBeNull();
  });

  it('is used by both GITHUB_OUTPUT fixers', () => {
    const files = [{ path: '.github/workflows/ci.yml', content: WORKFLOW_WITH_OUTPUT }];
    for (const fixes of [fixMissingJobOutputs(files), fixMissingJobOutputsDeclaration(files)]) {
      expect(fixes).toHaveLength(1);
      expect(fixes[0].content).toContain('steps.ver.outputs.tag');
    }
  });
});

describe('fixNonFastForwardPush', () => {
  const logs = 'error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind';
  const script = (p: string) => ({ path: p, content: 'release:\n  script:\n    - git commit -am "bump"\n    - git push origin HEAD\n' });

  it('uses $CI_COMMIT_REF_NAME in GitLab CI, not GitHub expression syntax', () => {
    const [fix] = fixNonFastForwardPush(logs, [script('.gitlab-ci.yml')]);
    expect(fix.content).toContain('git rebase origin/$CI_COMMIT_REF_NAME');
    expect(fix.content).not.toContain('${{');
  });

  it('keeps the GitHub expression for Actions workflows', () => {
    const [fix] = fixNonFastForwardPush(logs, [script('.github/workflows/release.yml')]);
    expect(fix.content).toContain("git rebase origin/${{ github.ref_name || 'main' }}");
  });
});

describe('fixGitLabVariableScope', () => {
  const ci = (globalKey: string) => [
    'variables:',
    `  ${globalKey}: "18"`,
    '',
    '  build:',
    '    variables:',
    '      NODE: "18"',
    '    script:',
    '      - echo hi',
    '',
  ].join('\n');

  it('removes a job variable that duplicates the global value', () => {
    expect(fixGitLabVariableScope([{ path: '.gitlab-ci.yml', content: ci('NODE') }])).toHaveLength(1);
  });

  it('does not treat a variable as shadowing a global whose name merely ends with it', () => {
    expect(fixGitLabVariableScope([{ path: '.gitlab-ci.yml', content: ci('MY_NODE') }])).toHaveLength(0);
  });
});

describe('validateFix', () => {
  it('blocks non-string content instead of throwing', () => {
    const r = validateFix({ path: 'a.yml', content: { oops: true } as unknown as string, explanation: '' });
    expect(r.safe).toBe(false);
  });
});

describe('geminiText', () => {
  it('joins every text part and skips thought summaries', () => {
    const data = { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '{"a":' }, { text: '1}' }] } }] };
    expect(geminiText(data)).toBe('{"a":1}');
  });

  it('returns empty string for malformed responses', () => {
    expect(geminiText(null)).toBe('');
    expect(geminiText({ candidates: [] })).toBe('');
  });
});

describe('isFailedConclusion', () => {
  it('treats startup_failure and timed_out as failing, success/skipped as not', () => {
    expect(isFailedConclusion('failure')).toBe(true);
    expect(isFailedConclusion('startup_failure')).toBe(true);
    expect(isFailedConclusion('timed_out')).toBe(true);
    expect(isFailedConclusion('success')).toBe(false);
    expect(isFailedConclusion('skipped')).toBe(false);
    expect(isFailedConclusion(null)).toBe(false);
  });
});
