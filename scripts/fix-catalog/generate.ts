// Generates fix-catalog/: one unified diff per error scenario, ordered from the
// simplest fix to the most complex, plus a README index.
//
//   pnpm catalog
//
// Every diff is produced by running the REAL rule engine on the fixture in
// fixtures.ts, so the catalog cannot drift from what Aegis actually commits.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, TIERS } from './fixtures';
import { buildEntry, type BuiltEntry } from './build';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'fix-catalog');

const firstLine = (log: string) => log.split('\n').find(l => l.trim())?.trim() ?? '';
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const mdCell = (s: string) => oneLine(s).replace(/\|/g, '\\|');

function header(n: string, b: BuiltEntry): string {
  const { entry } = b;
  const lines = [
    `Aegis fix catalog #${n} — ${entry.title}`,
    '',
    `Tier:       ${entry.tier} · ${TIERS[entry.tier].label}`,
    `Category:   ${entry.category}${b.diagnosed.includes(entry.category) ? ' (auto-diagnosed from the log below)' : ''}`,
    `Engine:     deterministic rule engine — no AI involved`,
    '',
    'CI log:',
    ...entry.log.split('\n').map(l => `  | ${l}`),
    '',
    'How it is solved:',
    ...b.changes.flatMap(c => [
      `  ${c.isNew ? 'CREATE' : 'MODIFY'} ${c.path}`,
      ...c.explanation.split('; ').map(e => `    - ${oneLine(e)}`),
    ]),
    '',
    `Apply:      git apply ${TIERS[entry.tier].dir}/${n}-${b.slug}.diff`,
  ];
  return lines.map(l => (l ? `# ${l}` : '#')).join('\n') + '\n';
}

function main() {
  const built = CATALOG
    .map((e, i) => ({ b: buildEntry(e), order: i }))
    .sort((x, y) => x.b.entry.tier - y.b.entry.tier || x.order - y.order)
    .map(x => x.b);

  const empty = built.filter(b => b.changes.length === 0).map(b => b.slug);
  if (empty.length) throw new Error(`Fixtures produced no fix: ${empty.join(', ')}`);
  const unsafe = built.flatMap(b => b.changes.filter(c => !c.safe).map(c => `${b.slug}:${c.path}`));
  if (unsafe.length) throw new Error(`Fixes failed validation: ${unsafe.join(', ')}`);

  // Everything validated — only now replace the old catalog. Clear the folder's
  // contents, not the folder itself (on Windows that fails with EBUSY when a
  // terminal or editor has it open).
  mkdirSync(OUT, { recursive: true });
  for (const entry of readdirSync(OUT)) rmSync(join(OUT, entry), { recursive: true, force: true });

  const rows: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  built.forEach((b, i) => {
    const n = String(i + 1).padStart(3, '0');
    const tier = TIERS[b.entry.tier];
    const file = `${n}-${b.slug}.diff`;
    mkdirSync(join(OUT, tier.dir), { recursive: true });
    writeFileSync(join(OUT, tier.dir, file), header(n, b) + b.changes.map(c => c.diff).join(''));

    const files = b.changes.map(c => `\`${c.path}\`${c.isNew ? ' (new)' : ''}`).join('<br>');
    const fix = b.changes.map(c => c.explanation.split(' — ')[0]).join('; ');
    rows[b.entry.tier].push(`| ${n} | [${mdCell(b.entry.title)}](${tier.dir}/${file}) | \`${b.entry.category}\` | \`${mdCell(firstLine(b.entry.log)).slice(0, 90)}\` | ${mdCell(fix)} | ${files} |`);
  });

  const total = built.length;
  const categories = new Set(built.map(b => b.entry.category)).size;
  const readme = [
    '# Aegis fix catalog',
    '',
    `${total} CI/CD failure scenarios covering ${categories} error categories. Each has a diff showing how Aegis heals the repo, ordered from the simplest fix to the most complex.`,
    '',
    'Every `.diff` in this folder is **real engine output**. `scripts/fix-catalog/generate.ts` runs the deterministic rule engine',
    '(`applyRuleBasedFixes`) on the broken repo and CI log in `scripts/fix-catalog/fixtures.ts` and records exactly what',
    'Aegis would commit on its fix branch. Each fix has passed the same safety validator that gates real PRs, which includes a YAML parse check.',
    '`tests/fixCatalog.test.ts` fails if any scenario stops producing its fix.',
    '',
    '- **Read a diff:** each file starts with a `#` header that gives the error, the CI log excerpt, and a plain-language explanation of every change.',
    '- **Apply a diff** to a repo in the same state: `git apply fix-catalog/<tier>/<n>-<slug>.diff` (git ignores the `#` header).',
    '- **Regenerate** after changing a fixer: `pnpm catalog`',
    '- **Not listed here:** failures the rules cannot fix (category `unknown`, or novel errors). Those go to the AI path (grounded Gemini → Groq → Gemini), and its fixes go through the same validator before a PR is opened.',
    '',
    ...([1, 2, 3, 4] as const).flatMap(t => [
      `## ${t}. ${TIERS[t].label}`,
      '',
      TIERS[t].blurb,
      '',
      '| # | Scenario | Category | Error signature | Fix | Files |',
      '|---|---|---|---|---|---|',
      ...rows[t],
      '',
    ]),
  ].join('\n');
  writeFileSync(join(OUT, 'README.md'), readme);
  console.log(`fix-catalog: wrote ${total} diffs (${categories} categories) to ${OUT}`);
}

main();
