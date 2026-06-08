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
  const blockRe = new RegExp(`(^${blockKey}:\\s*\\n(?:  [^\\n]+\\n)*)`, 'm');
  if (blockRe.test(content)) {
    return content.replace(blockRe, (match) => {
      let result = match;
      for (const entry of entries) {
        const key = entry.trim().split(':')[0];
        if (!result.includes(`${key}:`)) result += `${entry}\n`;
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
      out.push(newStep);
      modified = true;
    }
    out.push(lines[i]);
  }
  return modified ? out.join('\n') : null;
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
