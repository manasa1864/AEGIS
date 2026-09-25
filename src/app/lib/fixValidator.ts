// Validates AI-generated fixes before they are committed to the repository.
//
// Three classes of problem are caught here:
//   BLOCKED  — fix must not be applied (dangerous or clearly wrong)
//   WARNING  — fix is suspicious; logged to the stream but still applied
//   SAFE     — fix passes all checks

import { yamlParseError } from './yamlCheck';

export interface FixValidationResult {
  path: string;
  safe: boolean;
  blocked: string[];
  warnings: string[];
}

// Shell/script patterns that should never appear in CI config files.
const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/rm\s+-rf\s+[\/~]/, 'rm -rf targeting root or home'],
  [/curl\s+[^|]+\|\s*(ba)?sh/, 'curl piped to shell'],
  [/wget\s+[^|]+\|\s*(ba)?sh/, 'wget piped to shell'],
  [/>\s*\/etc\/(?:passwd|shadow|sudoers)/, 'overwrite of sensitive system file'],
  [/chmod\s+(?:a\+s|[0-7]*7[0-7]{2})\s/, 'world-writable or setuid chmod'],
  [/dd\s+if=.*of=\/dev\/(?:sd|hd|nvme)/, 'dd targeting a block device'],
  [/mkfs\s*\.\w+\s+\/dev\//, 'filesystem format on device'],
  [/:\(\)\s*\{.*\};\s*:/, 'fork bomb pattern'],
  [/base64\s+--decode.*\|\s*(ba)?sh/, 'base64-decoded shell execution'],
];

// File extensions that are valid targets for CI/CD fixes.
const KNOWN_SAFE_EXTENSIONS = new Set([
  '.yml', '.yaml', '.json', '.toml', '.ts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.mts', '.cts',
  '.vue', '.svelte', '.java', '.kt', '.cs', '.php', '.txt', '.cfg', '.ini', '.md',
  '.py', '.rb', '.go', '.rs', '.sh', '.bash', '.zsh', '.env.example',
  '.nvmrc', '.node-version', '.gitignore', '.dockerignore',
  '.eslintrc', '.eslintrc.json', '.prettierrc', '.prettierrc.json',
  '.stylelintrc', '.editorconfig', '.babelrc',
  'dockerfile', 'makefile', 'procfile', 'gemfile', 'pipfile',
]);

function extKnown(path: string): boolean {
  const lower = path.toLowerCase();
  const base  = lower.split('/').pop() ?? '';
  if (KNOWN_SAFE_EXTENSIONS.has(base)) return true;
  return [...KNOWN_SAFE_EXTENSIONS].some(ext => lower.endsWith(ext));
}

export function validateFix(
  fix: { path: string; content: string; explanation: string },
  originalContent?: string,
): FixValidationResult {
  const blocked: string[] = [];
  const warnings: string[] = [];

  // ── BLOCKED checks ─────────────────────────────────────────────────────────

  // 0. Missing or non-string path — AI sometimes omits this field
  if (!fix.path || typeof fix.path !== 'string') {
    return { path: String(fix.path ?? ''), safe: false, blocked: ['missing or non-string path'], warnings: [] };
  }
  // AI occasionally returns content as an object/array — every check below
  // (and the commit itself) assumes a string, so reject before they throw.
  if (typeof fix.content !== 'string') {
    return { path: fix.path, safe: false, blocked: [`non-string content for "${fix.path}"`], warnings: [] };
  }

  // 1. Path traversal
  if (fix.path.includes('../') || fix.path.includes('..\\')) {
    blocked.push(`path traversal in "${fix.path}"`);
  }

  // 2. Absolute paths — AI fixes must be repo-relative
  if (/^(\/|[A-Za-z]:[/\\])/.test(fix.path)) {
    blocked.push(`absolute path rejected: "${fix.path}"`);
  }

  // 3. Empty or trivially short content
  if (!fix.content || fix.content.trim().length < 5) {
    blocked.push(`empty content for "${fix.path}"`);
  }

  // 4. Dangerous shell patterns
  for (const [re, label] of DANGEROUS_PATTERNS) {
    if (re.test(fix.content)) {
      blocked.push(`dangerous pattern in "${fix.path}": ${label}`);
    }
  }

  // 5. JSON syntax validation
  if (fix.path.endsWith('.json')) {
    try {
      JSON.parse(fix.content);
    } catch (e) {
      blocked.push(`invalid JSON in "${fix.path}": ${(e as Error).message.split('\n')[0]}`);
    }
  }

  // 6. YAML tab-indentation — YAML forbids tabs
  if (fix.path.endsWith('.yml') || fix.path.endsWith('.yaml')) {
    const tabLines = fix.content.split('\n').filter(l => /^\t/.test(l)).length;
    if (tabLines > 0) {
      blocked.push(`YAML must use spaces not tabs in "${fix.path}" (${tabLines} tab-indented lines)`);
    }
  }

  // 6a. YAML must still parse — block fixes that break a file that parsed before
  // (a new file must parse too). If the original was already broken, only warn.
  if (fix.path.endsWith('.yml') || fix.path.endsWith('.yaml')) {
    const after = yamlParseError(fix.path, fix.content);
    if (after) {
      const before = originalContent === undefined ? null : yamlParseError(fix.path, originalContent);
      if (originalContent === undefined || before === null) blocked.push(`fix produces invalid YAML in "${fix.path}": ${after}`);
      else warnings.push(`"${fix.path}" was invalid YAML before the fix and still is: ${after}`);
    }
  }

  // 6b. Sanitizer placeholder — AI prompts see "[FILTERED]" in place of
  // injection-like text; a fix that echoes it back would corrupt the file.
  if (fix.content.includes('[FILTERED]') && !(originalContent ?? '').includes('[FILTERED]')) {
    blocked.push(`"${fix.path}" contains the prompt-sanitizer placeholder [FILTERED] — AI echoed redacted text`);
  }

  // ── WARNING checks ─────────────────────────────────────────────────────────

  // 7. Unknown file extension (AI invented a path)
  if (!extKnown(fix.path)) {
    warnings.push(`unusual file type: "${fix.path}" — verify before merging`);
  }

  // 8. Suspiciously large shrinkage vs. original (AI may have wiped the file)
  if (originalContent && originalContent.trim().length > 100) {
    const ratio = fix.content.trim().length / originalContent.trim().length;
    if (ratio < 0.25) {
      warnings.push(
        `"${fix.path}" shrunk to ${Math.round(ratio * 100)}% of original — confirm intentional`,
      );
    }
  }

  return {
    path: fix.path,
    safe: blocked.length === 0,
    blocked,
    warnings,
  };
}

/**
 * Validate a batch of fixes.
 * Returns the filtered list of safe fixes plus per-path results for logging.
 */
export function validateFixes<T extends { path: string; content: string; explanation: string }>(
  fixes: T[],
  originalFiles: Array<{ path: string; content: string }> = [],
): { safeFixes: T[]; results: FixValidationResult[] } {
  const fileMap = new Map(originalFiles.map(f => [f.path, f.content]));
  const results = fixes.map(fix => validateFix(fix, fileMap.get(fix.path)));
  return {
    safeFixes: fixes.filter((_, i) => results[i].safe),
    results,
  };
}
