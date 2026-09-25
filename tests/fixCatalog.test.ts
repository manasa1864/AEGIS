// The fix catalog (fix-catalog/) is generated from real engine output. These
// tests keep it honest: every scenario must still produce a validated fix,
// every diagnosable category must have a scenario, and the committed diffs
// must match what the engine produces today (run `pnpm catalog` to refresh).

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, TIERS } from '../scripts/fix-catalog/fixtures';
import { buildEntry } from '../scripts/fix-catalog/build';
import { DIAGNOSIS_PATTERNS } from '../src/app/lib/diagnostics';
import { yamlParseError } from '../src/app/lib/yamlCheck';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = CATALOG.map(buildEntry);

describe('fix catalog', () => {
  it('covers every diagnosable error category', () => {
    const covered = new Set(CATALOG.map(e => e.category));
    const missing = DIAGNOSIS_PATTERNS.map(p => p.category).filter(c => !covered.has(c));
    expect(missing).toEqual([]);
  });

  it('every scenario produces at least one fix, and every fix passes the safety validator', () => {
    for (const b of built) {
      expect(b.changes.length, b.slug).toBeGreaterThan(0);
      for (const c of b.changes) expect(c.safe, `${b.slug}: ${c.path}`).toBe(true);
    }
  }, 30_000);

  it('fixtures are valid YAML except where the scenario is a YAML syntax error', () => {
    // (fixed output is parse-checked by the validator in the test above)
    const intentionallyBroken = ['yaml_syntax', 'duplicate_config_key', 'git_merge_conflict', 'invalid_gitlab_ci'];
    for (const b of built) {
      if (intentionallyBroken.includes(b.slug)) continue;
      for (const f of b.inputFiles) {
        expect(yamlParseError(f.path, f.content), `${b.slug} fixture ${f.path}`).toBeNull();
      }
    }
  });

  it('committed diffs are up to date with the engine (run `pnpm catalog` if this fails)', () => {
    const sorted = [...built].sort((a, b) => a.entry.tier - b.entry.tier || CATALOG.indexOf(a.entry) - CATALOG.indexOf(b.entry));
    sorted.forEach((b, i) => {
      const n = String(i + 1).padStart(3, '0');
      const file = join(ROOT, 'fix-catalog', TIERS[b.entry.tier].dir, `${n}-${b.slug}.diff`);
      expect(existsSync(file), file).toBe(true);
      const onDisk = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const c of b.changes) {
        // Some rules name new files with a timestamp (e.g. SQL migrations) — compare those loosely.
        const stable = c.diff.replace(/\d{14}/g, '<ts>');
        expect(onDisk.replace(/\d{14}/g, '<ts>'), `${b.slug}: ${c.path}`).toContain(stable);
      }
    });
    const total = TIERS && Object.values(TIERS).reduce((n, t) => n + readdirSync(join(ROOT, 'fix-catalog', t.dir)).length, 0);
    expect(total).toBe(CATALOG.length);
  }, 30_000);
});
