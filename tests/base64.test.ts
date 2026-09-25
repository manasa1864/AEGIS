import { describe, it, expect } from 'vitest';
import { b64DecodeUtf8, b64EncodeUtf8 } from '../src/app/lib/base64';

describe('UTF-8-safe base64', () => {
  it('round-trips plain ASCII', () => {
    expect(b64DecodeUtf8(b64EncodeUtf8('hello world'))).toBe('hello world');
  });

  it('round-trips multi-byte UTF-8 (the old atob/btoa path corrupted these)', () => {
    const s = 'em dash — café ✓ 日本語 🚀';
    expect(b64DecodeUtf8(b64EncodeUtf8(s))).toBe(s);
  });

  it('does not throw on characters above U+00FF (old btoa threw here)', () => {
    expect(() => b64EncodeUtf8('smart “quotes” killed commits')).not.toThrow();
  });

  it('tolerates newlines inside base64 payloads (GitHub inserts them every 60 chars)', () => {
    const encoded = b64EncodeUtf8('a'.repeat(200));
    const withNewlines = encoded.match(/.{1,60}/g)!.join('\n');
    expect(b64DecodeUtf8(withNewlines)).toBe('a'.repeat(200));
  });

  it('round-trips a realistic workflow file', () => {
    const yaml = 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "building — stage 1 ✓"\n';
    expect(b64DecodeUtf8(b64EncodeUtf8(yaml))).toBe(yaml);
  });
});
