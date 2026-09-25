// Shared YAML patching utilities — imported by all rule-based fixer modules.

export interface RuleFix {
  path: string;
  content: string;
  explanation: string;
  confidence: number;
}

export const isGitHubWorkflow = (path: string) => typeof path === 'string' && path.includes('.github/workflows');
export const isGitLabCI      = (path: string) => typeof path === 'string' && (path.includes('.gitlab-ci') || path.endsWith('gitlab-ci.yml'));
export const isYAML          = (path: string) => typeof path === 'string' && (path.endsWith('.yml') || path.endsWith('.yaml'));

/**
 * Walk a GitHub Actions workflow line-by-line. For every job block where
 * shouldFix(block) returns true, push `injection` after the job declaration.
 * Returns null when nothing changed.
 */
export function patchGitHubJobBlocks(
  content: string,
  shouldFix: (block: string) => boolean,
  injection: string,
): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (/^  [\w-]+:\s*$/.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && (lines[end].startsWith('    ') || lines[end].trim() === '')) end++;
      const block = lines.slice(i + 1, end).join('\n');
      if (shouldFix(block)) { out.push(injection); modified = true; }
    }
  }
  return modified ? out.join('\n') : null;
}

/**
 * Same concept for GitLab CI — jobs live at root indent (0). Global keys skipped.
 */
export function patchGitLabJobBlocks(
  content: string,
  shouldFix: (block: string) => boolean,
  injection: string,
): string | null {
  const GLOBAL = new Set([
    'stages','image','variables','include','workflow',
    'before_script','after_script','default','cache','services',
  ]);
  const lines = content.split('\n');
  const out: string[] = [];
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/^([\w-]+):\s*$/);
    if (m && !GLOBAL.has(m[1])) {
      let end = i + 1;
      while (end < lines.length && (lines[end].startsWith('  ') || lines[end].trim() === '')) end++;
      const block = lines.slice(i + 1, end).join('\n');
      if (shouldFix(block)) { out.push(injection); modified = true; }
    }
  }
  return modified ? out.join('\n') : null;
}

/**
 * Add key:value entries to an existing workflow-level YAML block (env:, permissions:).
 * Creates the block immediately before `jobs:` if it does not exist yet.
 */
export function injectWorkflowLevelBlock(
  content: string,
  blockKey: string,
  entries: string[],
): string {
  const blockRe = new RegExp(`(^${blockKey}:[ \\t]*\\n(?:[ \\t]+[^\\n]+\\n)*)`, 'm');
  if (blockRe.test(content)) {
    return content.replace(blockRe, (match) => {
      // Entries are written with 2-space indent; match the block's actual indent.
      const indent = match.split('\n')[1]?.match(/^([ \t]+)\S/)?.[1] ?? '  ';
      let result = match;
      for (const entry of entries) {
        const key = entry.trim().split(':')[0];
        if (!new RegExp(`^[ \\t]+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm').test(result)) {
          result += `${entry.replace(/^ {2}/, indent)}\n`;
        }
      }
      return result;
    });
  }
  return content.replace(/^(jobs:)/m, `${blockKey}:\n${entries.join('\n')}\n\n$1`);
}

/**
 * Insert a new YAML step before the first step line matching `beforePattern`.
 * The pattern is tested against the full line; step lines start with spaces + "- ".
 */
export function insertStepBefore(
  content: string,
  beforePattern: RegExp,
  newStep: string,
): string | null {
  const lines = content.split('\n');
  const out: string[] = [];
  let modified = false;
  for (let i = 0; i < lines.length; i++) {
    if (!modified && /^\s+- /.test(lines[i]) && beforePattern.test(lines[i])) {
      // Steps are authored at 6-space indent; shift them to the target list's indent.
      const target = lines[i].match(/^(\s*)-/)![1].length;
      const stepLines = newStep.replace(/\n$/, '').split('\n');
      const base = stepLines[0].match(/^(\s*)/)![1].length;
      const shift = target - base;
      out.push(...stepLines.map(l => (l.trim() === '' ? l : shift >= 0 ? ' '.repeat(shift) + l : l.slice(Math.min(-shift, l.match(/^\s*/)![0].length)))));
      modified = true;
    }
    out.push(lines[i]);
  }
  return modified ? out.join('\n') : null;
}

/**
 * Insert `block` next to the first line whose KEY matches `key` (e.g. "image"),
 * re-indented to that key's column. `block` is authored with its first line at
 * `authoredIndent` spaces. Handles both manifest styles:
 *   containers:            containers:
 *   - name: app              - name: app
 *     image: x                 image: x
 * Returns null when the key is not found.
 */
export function insertBesideKey(
  content: string, key: string, block: string, authoredIndent: number, where: 'before' | 'after' = 'after',
): string | null {
  const lines = content.split('\n');
  const idx = lines.findIndex(l => new RegExp(`^[ \\t]*(?:- )?${key}:`).test(l));
  if (idx === -1) return null;
  const col = lines[idx].search(new RegExp(`${key}:`));
  const shift = col - authoredIndent;
  const blockLines = block.replace(/\n$/, '').split('\n').map(l => {
    if (l.trim() === '') return l;
    return shift >= 0 ? ' '.repeat(shift) + l : l.slice(Math.min(-shift, l.match(/^ */)![0].length));
  });
  // "after" an `image:` scalar line is simply the next line; for a key with a
  // nested block (ports:) insert after the whole block.
  let at = idx + 1;
  if (where === 'after') {
    while (at < lines.length && lines[at].trim() !== '' && (lines[at].match(/^ */)![0].length > col)) at++;
  } else {
    at = idx;
    // a "- key:" list-item line: insert before the item's dash would change the
    // item; keep before-insertion to plain key lines only
    if (/^[ \t]*- /.test(lines[idx])) return null;
  }
  lines.splice(at, 0, ...blockLines);
  return lines.join('\n');
}

/** Collect ${{ secrets.X }} references from content. */
export function extractSecretRefs(content: string): string[] {
  return [...new Set([...content.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map(m => m[1]))];
}

/** Collect ${{ env.X }} and bare $UPPER_CASE env var references from content. */
export function extractEnvRefs(content: string): string[] {
  const a = [...content.matchAll(/\$\{\{\s*env\.(\w+)\s*\}\}/g)].map(m => m[1]);
  const b = [...content.matchAll(/\$([A-Z_][A-Z0-9_]{2,})/g)].map(m => m[1]);
  return [...new Set([...a, ...b])];
}

/**
 * For every job that writes to $GITHUB_OUTPUT but declares no outputs:, add an
 * outputs: block after runs-on: mapping each written name to the step that
 * writes it. Entries must reference a real step id — a placeholder such as
 * steps.<step-id> is an invalid expression that breaks the whole workflow — so
 * outputs written by steps without an id: are skipped.
 * Returns null when nothing could be declared.
 */
export function declareJobOutputs(content: string): { content: string; names: string[] } | null {
  const lines = content.split('\n');
  const out: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!/^  [\w-]+:\s*$/.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && (lines[end].startsWith('    ') || lines[end].trim() === '')) end++;
    const jobLines = lines.slice(i + 1, end);
    if (!jobLines.some(l => l.includes('GITHUB_OUTPUT'))) continue;
    if (jobLines.some(l => /^    outputs:/.test(l))) continue;
    const runsOnIdx = jobLines.findIndex(l => /^    runs-on:/.test(l));
    if (runsOnIdx === -1) continue;

    // Split the job into steps (by the steps list's dash indentation) and pair
    // each output written inside a step with that step's id.
    const stepIndent = jobLines.find(l => /^\s+-\s/.test(l))?.match(/^(\s+)-/)?.[1].length;
    const jobOutputs: Array<{ name: string; stepId: string }> = [];
    let stepId: string | null = null;
    let pending: string[] = [];
    const flushStep = () => {
      if (stepId) {
        for (const name of pending) {
          if (!jobOutputs.some(o => o.name === name)) jobOutputs.push({ name, stepId });
        }
      }
      stepId = null;
      pending = [];
    };
    for (const l of jobLines) {
      const dash = l.match(/^(\s+)-\s/);
      if (dash && dash[1].length === stepIndent) flushStep();
      const id = l.match(/^\s+(?:-\s+)?id:\s*['"]?([\w-]+)/);
      if (id) stepId = id[1];
      const write = l.match(/echo\s+"?([\w-]+)=[^>\n]*>>\s*"?\$\{?GITHUB_OUTPUT/);
      if (write) pending.push(write[1]);
    }
    flushStep();
    if (jobOutputs.length === 0) continue;

    for (let j = 0; j <= runsOnIdx; j++) out.push(jobLines[j]);
    out.push('    outputs:');
    for (const o of jobOutputs) out.push(`      ${o.name}: \${{ steps.${o.stepId}.outputs.${o.name} }}`);
    names.push(...jobOutputs.map(o => o.name));
    i += runsOnIdx + 1;
  }
  return names.length > 0 ? { content: out.join('\n'), names } : null;
}
