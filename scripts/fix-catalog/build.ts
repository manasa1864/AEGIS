// Runs one catalog fixture through the real healing engine and returns the
// resulting per-file diffs. Shared by generate.ts (writes fix-catalog/) and
// tests/fixCatalog.test.ts (fails if a fixer stops producing its fix).

import { applyRuleBasedFixes } from '../../src/app/lib/ruleBasedFixer';
import { categorizeAllErrors } from '../../src/app/lib/diagnostics';
import { validateFixes } from '../../src/app/lib/fixValidator';
import { unifiedDiff } from '../../src/app/lib/lineDiff';
import { BASE_FILES, type CatalogEntry, type Files } from './fixtures';

export interface BuiltEntry {
  entry: CatalogEntry;
  slug: string;
  inputFiles: Files;
  diagnosed: string[];          // categories the diagnosis engine detects from the log
  changes: Array<{ path: string; isNew: boolean; explanation: string; diff: string; safe: boolean }>;
}

export function repoFor(entry: CatalogEntry): Files {
  const byPath = new Map(BASE_FILES.map(f => [f.path, f.content]));
  for (const f of entry.files ?? []) byPath.set(f.path, f.content);
  return [...byPath.entries()].map(([path, content]) => ({ path, content }));
}

export function buildEntry(entry: CatalogEntry): BuiltEntry {
  const inputFiles = repoFor(entry);
  const fixes = applyRuleBasedFixes(entry.category, entry.log, inputFiles);
  const { results } = validateFixes(fixes, inputFiles);
  const original = new Map(inputFiles.map(f => [f.path, f.content]));

  const changes = fixes
    .map((f, i) => {
      const before = original.has(f.path) ? original.get(f.path)! : null;
      return {
        path: f.path,
        isNew: before === null,
        explanation: f.explanation,
        diff: unifiedDiff(f.path, before, f.content),
        safe: results[i].safe,
      };
    })
    .filter(c => c.diff !== '')
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    entry,
    slug: entry.id ?? entry.category,
    inputFiles,
    diagnosed: categorizeAllErrors(entry.log).all.map(d => d.category),
    changes,
  };
}
