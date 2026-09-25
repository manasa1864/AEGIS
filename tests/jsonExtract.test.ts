import { describe, it, expect } from 'vitest';
import { extractJson } from '../src/app/lib/jsonExtract';

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('ignores leading and trailing prose', () => {
    const text = 'Here is my analysis:\n{"confidence": 90, "fixes": []}\nHope that helps!';
    expect(extractJson(text)).toEqual({ confidence: 90, fixes: [] });
  });

  it('handles unbalanced braces inside string literals (GitHub Actions expressions)', () => {
    // "if: ${{ always() }" has one more { than } inside the string — the old
    // naive depth counter terminated early and produced invalid JSON.
    const payload = { fixes: [{ path: 'ci.yml', content: 'if: ${{ always() }' }] };
    const text = 'Analysis follows.\n' + JSON.stringify(payload) + '\nDone.';
    expect(extractJson(text)).toEqual(payload);
  });

  it('handles escaped quotes inside strings', () => {
    const payload = { analysis: 'the "run" key {is} broken \\ badly' };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });

  it('skips a stray { in leading prose', () => {
    const text = 'weird { prose\n{"ok": true}';
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it('returns null when no JSON is present', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
