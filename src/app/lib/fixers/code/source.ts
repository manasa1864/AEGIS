// Code-level fixers — edit application SOURCE files, not CI config.
//
// Every fixer here is surgical: it acts only on a file (and usually a line)
// that the CI log explicitly points at, and only when the log names the exact
// problem. Nothing is rewritten file-wide on a hunch — a source edit that is
// wrong breaks the build it was meant to heal.
//
// Source files reach the engine because contextBuilder fetches every file the
// logs reference (see extractLogFileRefs), in addition to the CI config set.

import type { RuleFix } from '../helpers';

type Files = Array<{ path: string; content: string }>;

export interface LogFileRef { path: string; line?: number; col?: number }

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|cs|rb|php|swift|scala|c|cc|cpp|h|hpp)$/i;

// CI runners check the repo out under a workspace prefix — strip it so the
// path matches the repo-relative paths returned by the contents API.
const WORKSPACE_PREFIXES: RegExp[] = [
  /^\/home\/runner\/work\/[^/]+\/[^/]+\//,   // GitHub-hosted Linux
  /^\/Users\/runner\/work\/[^/]+\/[^/]+\//,  // GitHub-hosted macOS
  /^[A-Za-z]:[\\/]a[\\/][^\\/]+[\\/][^\\/]+[\\/]/, // GitHub-hosted Windows (D:\a\repo\repo\)
  /^\/github\/workspace\//,                    // container actions
  /^\/builds\/(?:[^/]+\/)+?[^/]+\/(?=[^/]+\/|[^/]+\.\w+$)/, // GitLab (/builds/group/project/)
  /^\/app\//, /^\/usr\/src\/app\//, /^\/workspace\//,
];

// Tool config files share source extensions (vite.config.ts, .eslintrc.js) but
// belong to the CI/config fixers, not the application-code fixers.
const CONFIG_FILE = /(?:^|\/)(?:[\w.-]+\.config|\.[\w-]+rc)\.[cm]?[jt]s$/;

/** True for application source code (as opposed to CI config / tool config files). */
export function isAppSourceFile(path: string): boolean {
  return SOURCE_EXT.test(path) && !CONFIG_FILE.test(path);
}

export function normalizeRepoPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/').replace(/^file:\/\//, '');
  for (const re of WORKSPACE_PREFIXES) p = p.replace(re, '');
  return p.replace(/^\.\//, '');
}

function isRepoRelativeSource(p: string): boolean {
  return SOURCE_EXT.test(p) && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) &&
    !p.includes('node_modules/') && !p.includes('site-packages/') && !p.startsWith('..') &&
    !p.startsWith('internal/') && !p.includes('<');
}

/** Every repo-relative source location mentioned in CI output. */
export function extractLogFileRefs(logs: string): LogFileRef[] {
  const refs: LogFileRef[] = [];
  const add = (rawPath: string, line?: string, col?: string) => {
    const path = normalizeRepoPath(rawPath);
    if (!isRepoRelativeSource(path)) return;
    refs.push({ path, line: line ? Number(line) : undefined, col: col ? Number(col) : undefined });
  };

  let currentFile: string | null = null; // ESLint "stylish" prints the path once, then "  line:col  error ..."
  for (const rawLine of logs.split('\n')) {
    const line = rawLine.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''); // GitHub timestamp prefix
    let m: RegExpMatchArray | null;

    if ((m = line.match(/^\s*([^\s:()]+\.\w+)\((\d+),(\d+)\):\s*(?:error|warning)/))) { add(m[1], m[2], m[3]); continue; } // tsc
    if ((m = line.match(/File "([^"]+)", line (\d+)/))) { add(m[1], m[2]); continue; }                                     // Python traceback
    if ((m = line.match(/^\s*(?:FAIL|PASS|❯|×|✓)\s+([^\s:>]+\.\w+)/))) { add(m[1]); }                                       // jest / vitest file header
    if ((m = line.match(/^\s*((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@.\-/\\]+\.\w+)\s*$/)) && SOURCE_EXT.test(m[1])) {    // ESLint stylish file header
      currentFile = m[1]; add(m[1]); continue;
    }
    if (currentFile && (m = line.match(/^\s+(\d+):(\d+)\s+(?:error|warning)\s/))) { add(currentFile, m[1], m[2]); continue; }
    for (const g of line.matchAll(/((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@.\-/\\]+\.[A-Za-z]{1,6}):(\d+)(?::(\d+))?/g)) {  // path:line[:col]
      add(g[1], g[2], g[3]);
    }
  }

  // de-duplicate (same path+line)
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = `${r.path}:${r.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Repo-relative source paths the logs point at — what contextBuilder should fetch. */
export function logReferencedSourcePaths(logs: string, max = 8): string[] {
  return [...new Set(extractLogFileRefs(logs).map(r => r.path))].slice(0, max);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve a log path to a context file (logs may carry a sub-directory prefix). */
function findFile(files: Files, logPath: string): { path: string; content: string } | undefined {
  return files.find(f => f.path === logPath)
    ?? files.find(f => logPath.endsWith(`/${f.path}`) || f.path.endsWith(`/${logPath}`));
}

/** Collect per-file line edits, then emit one RuleFix per changed file. */
class SourceEdits {
  private edited = new Map<string, string[]>();
  private notes = new Map<string, string[]>();
  constructor(private files: Files) {}

  lines(path: string): string[] | null {
    if (!this.edited.has(path)) {
      const f = this.files.find(x => x.path === path);
      if (!f) return null;
      this.edited.set(path, f.content.split('\n'));
    }
    return this.edited.get(path)!;
  }

  note(path: string, msg: string) {
    if (!this.notes.has(path)) this.notes.set(path, []);
    if (!this.notes.get(path)!.includes(msg)) this.notes.get(path)!.push(msg);
  }

  result(summary: (notes: string[]) => string, confidence: number): RuleFix[] {
    const out: RuleFix[] = [];
    for (const [path, lines] of this.edited) {
      const content = (keepPlaceholders ? lines : lines.filter(l => l !== REMOVED)).join('\n');
      const original = this.files.find(f => f.path === path)!.content;
      if (content !== original && this.notes.has(path)) {
        out.push({ path, content, explanation: summary(this.notes.get(path)!), confidence });
      }
    }
    return out;
  }
}
const REMOVED = '\u0000__aegis_removed__';

// Several fixers may edit one file at line numbers the tools printed. While the
// engine runs them, a removed line stays as a placeholder so the next fixer's
// line numbers still point at the right code; the engine strips placeholders after.
let keepPlaceholders = false;

/** Run line-precise fixers with removed lines kept as placeholders (see above). */
export function withStableLineNumbers<T>(fn: () => T): T {
  const prev = keepPlaceholders;
  keepPlaceholders = true;
  try { return fn(); } finally { keepPlaceholders = prev; }
}
export const hasLinePlaceholders = (content: string) => content.includes(REMOVED);
export const stripLinePlaceholders = (content: string) => content.split('\n').filter(l => l !== REMOVED).join('\n');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ═════════════════════════════════════════════════════════════════════════════
// 1. Unused imports — TS6133 / TS6192 / ESLint no-unused-vars on import lines
// ═════════════════════════════════════════════════════════════════════════════

/** Remove `name` from an import statement on one line. Returns the new line,
 *  REMOVED when nothing is left to import, or null when the line isn't an import of `name`. */
function dropImportSpecifier(line: string, name: string): string | null {
  const m = line.match(/^(\s*)import\s+(type\s+)?(.+?)\s+from\s+(['"][^'"]+['"];?\s*)$/);
  if (!m) return null;
  const [, indent, typeKw = '', clause, fromPart] = m;
  const n = escapeRe(name);

  let def: string | null = null;
  let ns: string | null = null;
  let named: string[] = [];
  const braces = clause.match(/\{([^}]*)\}/);
  if (braces) named = braces[1].split(',').map(s => s.trim()).filter(Boolean);
  const outside = clause.replace(/\{[^}]*\}/, '').split(',').map(s => s.trim()).filter(Boolean);
  for (const part of outside) {
    const nsMatch = part.match(/^\*\s+as\s+(\w+)$/);
    if (nsMatch) ns = nsMatch[1]; else def = part;
  }

  let changed = false;
  if (def === name) { def = null; changed = true; }
  if (ns === name) { ns = null; changed = true; }
  const keep = named.filter(s => !new RegExp(`^(?:type\\s+)?(?:\\w+\\s+as\\s+)?${n}$`).test(s));
  if (keep.length !== named.length) { named = keep; changed = true; }
  if (!changed) return null;

  const parts: string[] = [];
  if (def) parts.push(def);
  if (ns) parts.push(`* as ${ns}`);
  if (named.length) parts.push(`{ ${named.join(', ')} }`);
  if (parts.length === 0) return REMOVED;
  return `${indent}import ${typeKw}${parts.join(', ')} from ${fromPart}`;
}

export function fixUnusedImports(logs: string, files: Files): RuleFix[] {
  const findings: Array<{ ref: string; line: number; name?: string; all?: boolean }> = [];
  for (const raw of logs.split('\n')) {
    let m = raw.match(/([^\s(]+\.[cm]?[jt]sx?)\((\d+),\d+\):\s*error TS6133: '([\w$]+)' is declared but its value is never read/);
    if (m) { findings.push({ ref: normalizeRepoPath(m[1]), line: +m[2], name: m[3] }); continue; }
    m = raw.match(/([^\s(]+\.[cm]?[jt]sx?)\((\d+),\d+\):\s*error TS6192: All imports in import declaration are unused/);
    if (m) { findings.push({ ref: normalizeRepoPath(m[1]), line: +m[2], all: true }); continue; }
  }
  // ESLint stylish output: a file header line, then "  line:col  error  msg  rule"
  let current: string | null = null;
  for (const raw of logs.split('\n')) {
    const header = raw.match(/^\s*((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@.\-/\\]+\.[cm]?[jt]sx?)\s*$/);
    if (header) { current = normalizeRepoPath(header[1]); continue; }
    const m = raw.match(/^\s*(\d+):\d+\s+(?:error|warning)\s+'([\w$]+)' is (?:defined|assigned a value) but never used.*(?:no-unused-vars)/);
    if (current && m) findings.push({ ref: current, line: +m[1], name: m[2] });
  }
  if (findings.length === 0) return [];

  const edits = new SourceEdits(files);
  for (const f of findings) {
    const file = findFile(files, f.ref);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = f.line - 1;
    if (idx < 0 || idx >= lines.length || lines[idx] === REMOVED) continue;

    if (f.all) {
      if (/^\s*import\s.+\sfrom\s+['"][^'"]+['"];?\s*$/.test(lines[idx])) {
        lines[idx] = REMOVED;
        edits.note(file.path, 'removed an import whose bindings are all unused (TS6192)');
      }
      continue;
    }
    const name = f.name!;
    const single = dropImportSpecifier(lines[idx], name);
    if (single !== null) {
      lines[idx] = single;
      edits.note(file.path, `removed unused import '${name}'`);
      continue;
    }
    // Multi-line `import {\n  a,\n  b,\n} from 'x'` — the specifier sits on its own line.
    if (new RegExp(`^\\s*(?:type\\s+)?(?:\\w+\\s+as\\s+)?${escapeRe(name)},?\\s*$`).test(lines[idx])) {
      let k = idx - 1;
      while (k >= 0 && !/\bimport\b/.test(lines[k]) && !/[;)]\s*$/.test(lines[k])) k--;
      if (k >= 0 && /^\s*import\s+(type\s+)?\{\s*$|^\s*import\s+(type\s+)?\w+,\s*\{\s*$/.test(lines[k])) {
        lines[idx] = REMOVED;
        edits.note(file.path, `removed unused import '${name}'`);
      }
    }
    // Anything else (unused local variable, parameter) is left alone — removing
    // it could drop a side effect, so that belongs to a human or the AI pass.
  }
  return edits.result(
    notes => `Removed unused imports reported by the compiler/linter (${notes.join('; ')}) — noUnusedLocals / no-unused-vars fail the build; only import bindings were touched, never statements with side effects`,
    95,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Python unused imports — flake8 / ruff / pyflakes F401
// ═════════════════════════════════════════════════════════════════════════════

export function fixPythonUnusedImports(logs: string, files: Files): RuleFix[] {
  const findings: Array<{ ref: string; line: number; name: string }> = [];
  for (const raw of logs.split('\n')) {
    const m = raw.match(/([^\s:]+\.py):(\d+):\d+:\s*F401\s+(?:\[\*\]\s+)?['`]([\w.]+(?: as \w+)?)['`] imported but unused/);
    if (m) findings.push({ ref: normalizeRepoPath(m[1]), line: +m[2], name: m[3] });
  }
  if (findings.length === 0) return [];

  const edits = new SourceEdits(files);
  for (const f of findings) {
    const file = findFile(files, f.ref);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = f.line - 1;
    const line = lines[idx];
    if (line === undefined || line === REMOVED) continue;
    // pyflakes reports the imported dotted name plus any alias: 'os.path', 'typing.List', 'a.b as c'
    const [full, alias] = f.name.split(' as ');
    const parseSpec = (spec: string) => { const [name, as] = spec.split(/\s+as\s+/); return { name: name.trim(), as: as?.trim() }; };

    let m = line.match(/^(\s*)import\s+([^()#]+?)\s*(#.*)?$/);
    if (m) {
      const specs = m[2].split(',').map(x => x.trim()).filter(Boolean);
      const keep = specs.filter(x => { const p = parseSpec(x); return !(p.name === full && p.as === alias); });
      if (keep.length === specs.length) continue;
      lines[idx] = keep.length ? `${m[1]}import ${keep.join(', ')}${m[3] ? `  ${m[3]}` : ''}` : REMOVED;
      edits.note(file.path, `'${f.name}'`);
      continue;
    }
    m = line.match(/^(\s*)from\s+([\w.]+)\s+import\s+([^()#]+?)\s*(#.*)?$/);
    if (m) {
      const mod = m[2];
      const specs = m[3].split(',').map(x => x.trim()).filter(Boolean);
      const keep = specs.filter(x => { const p = parseSpec(x); return !(`${mod}.${p.name}` === full && p.as === alias); });
      if (keep.length === specs.length) continue;
      lines[idx] = keep.length ? `${m[1]}from ${mod} import ${keep.join(', ')}${m[4] ? `  ${m[4]}` : ''}` : REMOVED;
      edits.note(file.path, `'${f.name}'`);
    }
  }
  return edits.result(
    notes => `Removed unused Python imports ${notes.join(', ')} flagged by flake8/ruff F401 — lint gates in CI fail on unused imports`,
    95,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. prefer-const — ESLint "'x' is never reassigned. Use 'const' instead"
// ═════════════════════════════════════════════════════════════════════════════

export function fixPreferConst(logs: string, files: Files): RuleFix[] {
  if (!/prefer-const/.test(logs)) return [];
  const edits = new SourceEdits(files);
  let current: string | null = null;
  for (const raw of logs.split('\n')) {
    const header = raw.match(/^\s*((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@.\-/\\]+\.[cm]?[jt]sx?)\s*$/);
    if (header) { current = normalizeRepoPath(header[1]); continue; }
    const m = raw.match(/^\s*(\d+):\d+\s+(?:error|warning)\s+'([\w$]+)' is never reassigned\. Use 'const' instead\s+prefer-const/);
    if (!m || !current) continue;
    const file = findFile(files, current);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = +m[1] - 1;
    // Only a single simple declarator — `let a = 1, b = 2` may have a reassigned sibling.
    const re = new RegExp(`^(\\s*(?:export\\s+)?)let(\\s+${escapeRe(m[2])}\\s*(?::[^=,]+)?=[^,;]*;?\\s*(?://.*)?)$`);
    if (lines[idx] !== undefined && re.test(lines[idx])) {
      lines[idx] = lines[idx].replace(re, '$1const$2');
      edits.note(file.path, `'${m[2]}'`);
    }
  }
  return edits.result(notes => `Changed let → const for ${notes.join(', ')} (ESLint prefer-const) — the variables are never reassigned, so the lint gate rejected them`, 95);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Leftover debugger statements / breakpoints
// ═════════════════════════════════════════════════════════════════════════════

export function fixDebuggerStatements(logs: string, files: Files): RuleFix[] {
  const jsDebugger = /no-debugger|Unexpected 'debugger' statement/.test(logs);
  const pyBreakpoint = /reading from stdin while output is captured|bdb\.BdbQuit|\(Pdb\)|T100 .*breakpoint|debugger.*(?:found|imported)/i.test(logs);
  if (!jsDebugger && !pyBreakpoint) return [];

  const referenced = new Set(extractLogFileRefs(logs).map(r => r.path));
  const edits = new SourceEdits(files);
  for (const f of files) {
    const isRef = [...referenced].some(r => r === f.path || r.endsWith(`/${f.path}`) || f.path.endsWith(`/${r}`));
    if (!isRef) continue;
    const lines = edits.lines(f.path)!;
    lines.forEach((line, i) => {
      if (jsDebugger && /\.[cm]?[jt]sx?$/.test(f.path) && /^\s*debugger;?\s*$/.test(line)) {
        lines[i] = REMOVED; edits.note(f.path, 'debugger statement');
      }
      if (pyBreakpoint && f.path.endsWith('.py') &&
          /^\s*(?:breakpoint\(\)|import i?pdb;\s*i?pdb\.set_trace\(\)|i?pdb\.set_trace\(\))\s*(#.*)?$/.test(line)) {
        lines[i] = REMOVED; edits.note(f.path, 'breakpoint()/pdb.set_trace()');
      }
    });
  }
  return edits.result(notes => `Removed leftover ${notes.join(' and ')} — a debugger left in committed code fails the lint gate or blocks CI waiting for interactive input`, 98);
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Whitespace lint — trailing spaces, missing final newline
// ═════════════════════════════════════════════════════════════════════════════

export function fixWhitespaceLint(logs: string, files: Files): RuleFix[] {
  const trailing = /\bW29[13]\b|trailing whitespace|no-trailing-spaces|Trailing spaces not allowed/i.test(logs);
  const eol = /\bW292\b|no newline at end of file|eol-last|Newline required at end of file/i.test(logs);
  const extraBlank = /\bW391\b|blank line at end of file|no-multiple-empty-lines.*EOF/i.test(logs);
  if (!trailing && !eol && !extraBlank) return [];

  const referenced = extractLogFileRefs(logs).map(r => r.path);
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!referenced.some(r => r === f.path || r.endsWith(`/${f.path}`) || f.path.endsWith(`/${r}`))) continue;
    let content = f.content;
    if (trailing) content = content.replace(/[ \t]+$/gm, '');
    if (extraBlank || eol) content = content.replace(/\n+$/, '') + '\n';
    if (content !== f.content) {
      fixes.push({ path: f.path, content, explanation: 'Normalized whitespace flagged by the linter (trailing spaces removed, exactly one newline at end of file) — pure formatting, no code change', confidence: 99 });
    }
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Leftover focused tests — .only
// ═════════════════════════════════════════════════════════════════════════════

export function fixFocusedTests(logs: string, files: Files): RuleFix[] {
  if (!/\.only forbidden|Unexpected \.only modifier|--forbid-only|no-focused-tests|allowOnly/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files) {
    if (!/(?:\.|\/|_)(?:test|spec)s?\.[cm]?[jt]sx?$|__tests__\//.test(f.path)) continue;
    const content = f.content.replace(/\b(describe|it|test|context|suite)\.only\s*\(/g, '$1(');
    if (content !== f.content) {
      fixes.push({ path: f.path, content, explanation: 'Removed .only from focused tests — the runner refuses .only in CI (forbid-only / allowOnly=false) because it silently skips every other test', confidence: 98 });
    }
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Unused @ts-expect-error — TS2578
// ═════════════════════════════════════════════════════════════════════════════

export function fixUnusedTsExpectError(logs: string, files: Files): RuleFix[] {
  const edits = new SourceEdits(files);
  for (const raw of logs.split('\n')) {
    const m = raw.match(/([^\s(]+\.[cm]?[jt]sx?)\((\d+),\d+\):\s*error TS2578: Unused '@ts-expect-error' directive/)
      ?? raw.match(/([^\s:]+\.[cm]?[jt]sx?):(\d+):\d+.*error TS2578/);
    if (!m) continue;
    const file = findFile(files, normalizeRepoPath(m[1]));
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = +m[2] - 1;
    if (lines[idx] !== undefined && /^\s*\/\/\s*@ts-expect-error\b.*$/.test(lines[idx])) {
      lines[idx] = REMOVED;
      edits.note(file.path, 'directive');
    }
  }
  return edits.result(() => "Removed unused '@ts-expect-error' directives (TS2578) — the error they suppressed no longer exists, and TypeScript fails the build on a directive with nothing to suppress", 97);
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Null dereference at the crashing stack frame
// ═════════════════════════════════════════════════════════════════════════════

export function fixNullDerefAtStackFrame(logs: string, files: Files): RuleFix[] {
  const errMatch = logs.match(/TypeError: Cannot read propert(?:y|ies) (?:of (?:null|undefined) \(reading '([\w$]+)'\)|'([\w$]+)' of (?:null|undefined))/);
  if (!errMatch) return [];
  const prop = errMatch[1] ?? errMatch[2];
  // The first stack frame inside the repo is where the dereference happened.
  const errIdx = logs.indexOf(errMatch[0]);
  const frame = logs.slice(errIdx).split('\n').slice(1, 15)
    .map(l => l.match(/^\s*at .*?\(?((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[^\s():]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?\s*$/))
    .find(m => m && isRepoRelativeSource(normalizeRepoPath(m[1])));
  if (!frame) return [];
  const file = findFile(files, normalizeRepoPath(frame[1]));
  if (!file) return [];

  const lines = file.content.split('\n');
  const idx = +frame[2] - 1;
  const line = lines[idx];
  if (line === undefined) return [];

  // Reading `arr[i].prop` inside `for (…; i <= arr.length; …)` — the last
  // iteration indexes one past the end. The loop bound is the bug, not the access.
  for (const idxAccess of line.matchAll(/([\w$.]+)\[([\w$]+)\]/g)) {
    const [, arr, iv] = idxAccess;
    const bound = new RegExp(`(\\b${escapeRe(iv)}\\s*)<=(\\s*${escapeRe(arr)}\\.length\\b)`);
    for (let k = idx; k >= Math.max(0, idx - 12); k--) {
      if (!/\bfor\s*\(/.test(lines[k]) || !bound.test(lines[k])) continue;
      lines[k] = lines[k].replace(bound, '$1<$2');
      return [{
        path: file.path,
        content: lines.join('\n'),
        explanation: `Fixed an off-by-one loop bound at ${file.path}:${k + 1} (${iv} <= ${arr}.length → ${iv} < ${arr}.length) — the last iteration read ${arr}[${arr}.length], which is undefined, causing "Cannot read properties of undefined (reading '${prop}')"`,
        confidence: 92,
      }];
    }
  }

  // Guard the property access nearest to the reported column.
  const col = +frame[3] - 1;
  // `.prop` directly after an identifier/`)`/`]` — i.e. not already `?.prop`
  const re = new RegExp(`(?<=[\\w$\\])])\\.(${escapeRe(prop)})\\b`, 'g');
  const hits = [...line.matchAll(re)];
  if (hits.length === 0) return [];
  const target = hits.reduce((best, h) => (Math.abs(h.index! - col) < Math.abs(best.index! - col) ? h : best));
  lines[idx] = line.slice(0, target.index!) + '?' + line.slice(target.index!);
  return [{
    path: file.path,
    content: lines.join('\n'),
    explanation: `Guarded .${prop} with optional chaining at ${file.path}:${idx + 1} — the stack trace shows the object was null/undefined there; the access now yields undefined instead of throwing. Review whether a default value is more appropriate`,
    confidence: 80,
  }];
}

// 9. Missing npm packages live in ./manifests (they edit package.json, not source).

// ═════════════════════════════════════════════════════════════════════════════
// 10. Missing Python package — ModuleNotFoundError
// ═════════════════════════════════════════════════════════════════════════════

// import name → PyPI distribution name, where they differ
const PY_DIST: Record<string, string> = {
  yaml: 'PyYAML', cv2: 'opencv-python', PIL: 'Pillow', sklearn: 'scikit-learn', bs4: 'beautifulsoup4',
  dotenv: 'python-dotenv', dateutil: 'python-dateutil', jwt: 'PyJWT', Crypto: 'pycryptodome',
  google: 'protobuf', magic: 'python-magic', serial: 'pyserial', usb: 'pyusb', attr: 'attrs',
  jose: 'python-jose', multipart: 'python-multipart', psycopg2: 'psycopg2-binary', MySQLdb: 'mysqlclient',
  win32api: 'pywin32', docx: 'python-docx', pptx: 'python-pptx', fitz: 'PyMuPDF', skimage: 'scikit-image',
};
const PY_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'math', 'time', 'datetime', 'typing', 'pathlib', 'logging', 'collections',
  'itertools', 'functools', 'subprocess', 'unittest', 'asyncio', 'abc', 'io', 'random', 'string', 'enum',
  'dataclasses', 'copy', 'csv', 'hashlib', 'base64', 'uuid', 'tempfile', 'shutil', 'glob', 'argparse',
  'threading', 'multiprocessing', 'socket', 'http', 'urllib', 'email', 'sqlite3', 'decimal', 'fractions',
  'statistics', 'contextlib', 'inspect', 'traceback', 'warnings', 'pickle', 'struct', 'zipfile', 'tarfile',
  'gzip', 'textwrap', 'pprint', 'secrets', 'hmac', 'queue', 'heapq', 'bisect', 'weakref', 'types', 'ast',
  'platform', 'signal', 'select', 'ssl', 'xml', 'html', 'configparser', 'importlib', 'pkgutil', 'site',
  'distutils', 'venv', 'zoneinfo', 'graphlib', 'tomllib', 'operator', 'numbers', 'codecs', 'locale', 'gettext',
]);

export function fixMissingPythonPackage(logs: string, files: Files): RuleFix[] {
  const req = files.find(f => /(^|\/)requirements\.txt$/.test(f.path));
  if (!req) return [];
  const listed = new Set(req.content.split('\n')
    .map(l => l.trim().split(/[<>=!~;[ #]/)[0].toLowerCase().replace(/_/g, '-'))
    .filter(Boolean));

  const missing: string[] = [];
  for (const m of logs.matchAll(/ModuleNotFoundError: No module named '([\w.]+)'/g)) {
    const top = m[1].split('.')[0];
    if (PY_STDLIB.has(top)) continue;
    // A local package/module in the repo — this is a PYTHONPATH problem, not a missing dependency.
    if (files.some(f => f.path === `${top}.py` || f.path.startsWith(`${top}/`) || f.path.includes(`/${top}/`) || f.path.endsWith(`/${top}.py`))) continue;
    const dist = PY_DIST[top] ?? top;
    if (listed.has(dist.toLowerCase().replace(/_/g, '-')) || missing.includes(dist)) continue;
    missing.push(dist);
  }
  if (missing.length === 0) return [];
  const content = req.content.replace(/\n*$/, '\n') + missing.join('\n') + '\n';
  return [{
    path: req.path,
    content,
    explanation: `Added ${missing.join(', ')} to ${req.path} — the code imports ${missing.length > 1 ? 'them' : 'it'} (ModuleNotFoundError) but the dependency was never declared; pin a version before merging`,
    confidence: 85,
  }];
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. Compiler "did you mean …?" suggestions — apply the tool's own fix
// ═════════════════════════════════════════════════════════════════════════════
//
// Compilers already know the fix for many misspellings and print it. This
// applies exactly that replacement, at exactly the location they report:
//   TS2551/TS2552/TS2724  Property/name 'x' … Did you mean 'y'?
//   Python 3.10+          NameError / AttributeError / ImportError … Did you mean: 'y'?
//   rustc                 help: a … with a similar name exists: `y`

interface Suggestion { ref: string; line: number; col?: number; bad: string; good: string }

function collectSuggestions(logs: string): Suggestion[] {
  const out: Suggestion[] = [];
  const lines = logs.split('\n').map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));

  for (const l of lines) {
    // TypeScript (tsc pretty=false and path:line:col forms)
    const ts = l.match(/([^\s(]+\.[cm]?[jt]sx?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*[-:]\s*error TS(2551|2552|2724|2561): .*?'([\w$]+)'.*Did you mean (?:to write )?'([\w$]+)'\?/);
    if (ts) out.push({ ref: normalizeRepoPath(ts[1]), line: +(ts[2] ?? ts[4]), col: +(ts[3] ?? ts[5]), bad: ts[7], good: ts[8] });
  }

  // Python: the error line follows the traceback; its location is the last repo frame before it.
  for (let i = 0; i < lines.length; i++) {
    const py = lines[i].match(/^(?:NameError: name|AttributeError: .*has no attribute|ImportError: cannot import name) '(\w+)'.*Did you mean:? '(\w+)'\??/);
    if (!py) continue;
    for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
      const frame = lines[j].match(/File "([^"]+\.py)", line (\d+)/);
      if (frame && isRepoRelativeSource(normalizeRepoPath(frame[1]))) {
        out.push({ ref: normalizeRepoPath(frame[1]), line: +frame[2], bad: py[1], good: py[2] });
        break;
      }
    }
  }

  // rustc: error[E0425/E0412/E0433/E0599…]: … `bad` … / --> path:line:col / … help: … similar name exists: `good`
  for (let i = 0; i < lines.length; i++) {
    const err = lines[i].match(/^error\[E\d{4}\]: .*?`([\w:]+)`/);
    if (!err) continue;
    let loc: RegExpMatchArray | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      loc ??= lines[j].match(/-->\s+([^\s:]+\.rs):(\d+):(\d+)/);
      const help = lines[j].match(/help: .*similar name exists(?: in the \w+)?: `([\w:]+)`/);
      if (help && loc) { out.push({ ref: normalizeRepoPath(loc[1]), line: +loc[2], col: +loc[3], bad: err[1].split('::').pop()!, good: help[1].split('::').pop()! }); break; }
      if (/^error(\[|:)/.test(lines[j])) break;
    }
  }
  return out;
}

export function fixCompilerSuggestions(logs: string, files: Files): RuleFix[] {
  if (!/Did you mean|similar name exists/.test(logs)) return [];
  const edits = new SourceEdits(files);
  for (const s of collectSuggestions(logs)) {
    if (s.bad === s.good) continue;
    const file = findFile(files, s.ref);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = s.line - 1;
    const line = lines[idx];
    if (line === undefined || line === REMOVED) continue;
    const re = new RegExp(`(?<![\\w$])${escapeRe(s.bad)}(?![\\w$])`, 'g');
    const hits = [...line.matchAll(re)];
    if (hits.length === 0) continue;
    // the occurrence at (or nearest to) the reported column
    const col = (s.col ?? 1) - 1;
    const hit = hits.reduce((best, h) => (Math.abs(h.index! - col) < Math.abs(best.index! - col) ? h : best));
    lines[idx] = line.slice(0, hit.index!) + s.good + line.slice(hit.index! + s.bad.length);
    edits.note(file.path, `${s.bad} → ${s.good} (line ${s.line})`);
  }
  return edits.result(notes => `Applied the compiler's own "did you mean" suggestion${notes.length > 1 ? 's' : ''}: ${notes.join(', ')} — the compiler named the correct identifier; only that token at the reported location was changed`, 96);
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. ESLint rule violations with one safe mechanical fix
// ═════════════════════════════════════════════════════════════════════════════
//   eqeqeq            ==/!= → ===/!== at the reported operator
//   use-isnan         x == NaN → Number.isNaN(x)
//   no-console        drop a complete one-line console.* statement
//   no-var            top-level `var` → `let` when the name is declared once and not used earlier
//   no-unused-vars    drop an unused local whose initializer has no side effects
// Anything needing judgement (no-explicit-any, complex expressions) is left to the AI pass.

interface LintHit { ref: string; line: number; col: number; message: string; rule: string }

/** ESLint "stylish" (file header + indented rows) and "unix"/"compact" (path:line:col) output. */
export function parseEslintOutput(logs: string): LintHit[] {
  const hits: LintHit[] = [];
  let current: string | null = null;
  for (const rawLine of logs.split('\n')) {
    const raw = rawLine.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, '').replace(/^##\[(?:error|warning)\]/, '');
    const header = raw.match(/^\s*((?:\/|[A-Za-z]:[\\/]|\.{0,2}\/)?[\w@.\-/\\]+\.(?:[cm]?[jt]sx?|vue|svelte))\s*$/);
    if (header) { current = normalizeRepoPath(header[1]); continue; }
    let m = raw.match(/^\s*(\d+):(\d+)\s+(?:error|warning)\s+(.+?)\s{2,}(@?[\w-]+(?:\/[\w-]+)?)\s*$/);
    if (m && current) { hits.push({ ref: current, line: +m[1], col: +m[2], message: m[3], rule: m[4] }); continue; }
    m = raw.match(/^((?:\/|[A-Za-z]:[\\/])?[^\s:]+\.[cm]?[jt]sx?):(\d+):(\d+):\s*(.+?)\s*\[(?:Error|Warning)\/(@?[\w-]+(?:\/[\w-]+)?)\]\s*$/);
    if (m) hits.push({ ref: normalizeRepoPath(m[1]), line: +m[2], col: +m[3], message: m[4], rule: m[5] });
  }
  return hits;
}

const SIDE_EFFECT_FREE = /^(?:[\w$.[\]'"`\s+\-*/%]|\?\.|!|<|>|=(?==)|&&|\|\|)*$/; // no calls, `new`, assignment, await
const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) return false; }
  return depth === 0;
};

export function fixEslintRuleViolations(logs: string, files: Files): RuleFix[] {
  const hits = parseEslintOutput(logs).filter(h => /^(eqeqeq|use-isnan|no-console|no-var|(?:@typescript-eslint\/)?no-unused-vars)$/.test(h.rule));
  if (hits.length === 0) return [];
  const edits = new SourceEdits(files);
  for (const h of hits) {
    const file = findFile(files, h.ref);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = h.line - 1;
    const line = lines[idx];
    if (line === undefined || line === REMOVED) continue;
    const at = h.col - 1;

    if (h.rule === 'eqeqeq') {
      const loose = [...line.matchAll(/(?<![=!<>])([=!])=(?!=)/g)];
      const hit = loose.find(x => Math.abs(x.index! - at) <= 1) ?? (loose.length === 1 ? loose[0] : undefined);
      if (!hit) continue;
      lines[idx] = line.slice(0, hit.index!) + `${hit[1]}==` + line.slice(hit.index! + 2);
      edits.note(file.path, `strict equality at line ${h.line}`);
    } else if (h.rule === 'use-isnan') {
      const next = line
        .replace(/([\w$.[\]]+)\s*(===?|!==?)\s*NaN\b/, (_, x, op) => `${op.startsWith('!') ? '!' : ''}Number.isNaN(${x})`)
        .replace(/\bNaN\s*(===?|!==?)\s*([\w$.[\]]+)/, (_, op, x) => `${op.startsWith('!') ? '!' : ''}Number.isNaN(${x})`);
      if (next === line) continue;
      lines[idx] = next;
      edits.note(file.path, `NaN comparison at line ${h.line} (always false with ==)`);
    } else if (h.rule === 'no-console') {
      const stmt = line.match(/^\s*console\.\w+\((.*)\);?\s*(?:\/\/.*)?$/);
      if (!stmt || !balanced(`(${stmt[1]})`)) continue;
      lines[idx] = REMOVED;
      edits.note(file.path, `console statement at line ${h.line}`);
    } else if (h.rule === 'no-var') {
      const decl = line.match(/^var\s+([\w$]+)\b/);
      if (!decl) continue;
      const name = escapeRe(decl[1]);
      const declaredOnce = lines.filter(l => new RegExp(`^\\s*(?:var|let|const)\\s+${name}\\b`).test(l)).length === 1;
      const usedBefore = lines.slice(0, idx).some(l => new RegExp(`(?<![\\w$.])${name}(?![\\w$])`).test(l));
      if (!declaredOnce || usedBefore) continue;
      // never reassigned → const (a `let` would just trade no-var for prefer-const)
      const reassigned = lines.some((l, i) => i !== idx && (
        new RegExp(`(?<![\\w$.])${name}\\s*(?:[-+*/%&|^]|\\*\\*|<<|>>>?|\\?\\?|&&|\\|\\|)?=(?!=)`).test(l) ||
        new RegExp(`(?:\\+\\+|--)\\s*${name}(?![\\w$])|(?<![\\w$.])${name}\\s*(?:\\+\\+|--)`).test(l)));
      const kw = !reassigned && /=/.test(line.slice(decl[0].length)) ? 'const' : 'let';
      lines[idx] = line.replace(/^var\b/, kw);
      edits.note(file.path, `var → ${kw} at line ${h.line}`);
    } else {
      const unused = h.message.match(/^'([\w$]+)' is assigned a value but never used/);
      if (!unused) continue;
      const decl = line.match(new RegExp(`^\\s*(?:const|let|var)\\s+${escapeRe(unused[1])}(?:\\s*:\\s*[^=]+)?\\s*=\\s*(.+?);?\\s*(?://.*)?$`));
      if (!decl || !SIDE_EFFECT_FREE.test(decl[1]) || /\bawait\b|\bnew\b|\bdelete\b|\+\+|--/.test(decl[1])) continue;
      lines[idx] = REMOVED;
      edits.note(file.path, `unused variable '${unused[1]}' at line ${h.line}`);
    }
  }
  return edits.result(notes => `Fixed ESLint violations with their mechanical fix: ${notes.join('; ')} — only the reported tokens/lines were changed`, 93);
}

// ═════════════════════════════════════════════════════════════════════════════
// 13. Python lint violations (ruff / flake8 / pycodestyle / bugbear)
// ═════════════════════════════════════════════════════════════════════════════
//   E711  == None / != None      → is None / is not None
//   E722  bare `except:`         → except Exception:
//   F541  f-string without placeholders → plain string
//   B006  mutable default argument → None + initialise in the body

export function fixPythonLintViolations(logs: string, files: Files): RuleFix[] {
  const hits: Array<{ ref: string; line: number; col: number; code: string }> = [];
  for (const raw of logs.split('\n')) {
    const m = raw.match(/([^\s:]+\.py):(\d+):(\d+):\s*(E711|E722|F541|B006)\b/);
    if (m) hits.push({ ref: normalizeRepoPath(m[1]), line: +m[2], col: +m[3], code: m[4] });
  }
  if (hits.length === 0) return [];
  const edits = new SourceEdits(files);
  // Later lines first — B006 inserts a line, which must not shift pending line numbers.
  for (const h of hits.sort((a, b) => b.line - a.line)) {
    const file = findFile(files, h.ref);
    if (!file) continue;
    const lines = edits.lines(file.path)!;
    const idx = h.line - 1;
    const line = lines[idx];
    if (line === undefined || line === REMOVED) continue;

    if (h.code === 'E711') {
      const next = line.replace(/\s*!=\s*None\b/, ' is not None').replace(/\s*==\s*None\b/, ' is None');
      if (next === line) continue;
      lines[idx] = next;
      edits.note(file.path, `None comparison at line ${h.line}`);
    } else if (h.code === 'E722') {
      if (!/^\s*except\s*:/.test(line)) continue;
      lines[idx] = line.replace(/except\s*:/, 'except Exception:');
      edits.note(file.path, `bare except at line ${h.line}`);
    } else if (h.code === 'F541') {
      const at = h.col - 1;
      const pos = /[fF]/.test(line[at] ?? '') && /['"]/.test(line[at + 1] ?? '') ? at : line.search(/(?<![\w])[fF](?=['"])/);
      if (pos < 0) continue;
      const lit = line.slice(pos + 1).match(/^('''|"""|'|")(.*?)\1/);
      if (!lit || /[{}]/.test(lit[2])) continue;
      lines[idx] = line.slice(0, pos) + line.slice(pos + 1);
      edits.note(file.path, `f-string without placeholders at line ${h.line}`);
    } else {
      // def f(a, out=[]):  →  def f(a, out=None):  +  if out is None: out = []
      const def = line.match(/^(\s*)(?:async\s+)?def\s+\w+\(.*\):\s*(#.*)?$/);
      if (!def) continue;
      const params = [...line.matchAll(/([\w]+)\s*(?::\s*[^=,)]+)?=\s*(\[\]|\{\}|list\(\)|dict\(\)|set\(\))/g)];
      if (params.length === 0) continue;
      let next = line;
      for (const p of params) next = next.replace(p[0], p[0].replace(p[2], 'None'));
      // body indentation from the first non-blank line after the def (after a docstring, if any)
      let k = idx + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      const bodyIndent = lines[k]?.match(/^\s*/)?.[0] ?? `${def[1]}    `;
      if (bodyIndent.length <= def[1].length) continue;
      let insertAt = k;
      const doc = lines[k]?.trim().match(/^[rbuRBU]?('''|""")/);
      if (doc) {
        const q = doc[1];
        const rest = lines[k].trim().slice(lines[k].trim().indexOf(q) + 3);
        if (rest.includes(q)) insertAt = k + 1;
        else { let e = k + 1; while (e < lines.length && !lines[e].includes(q)) e++; insertAt = e + 1; }
      }
      lines[idx] = next;
      const inits = params.map(p => `${bodyIndent}if ${p[1]} is None:\n${bodyIndent}    ${p[1]} = ${p[2]}`);
      lines.splice(insertAt, 0, ...inits.join('\n').split('\n'));
      edits.note(file.path, `mutable default argument${params.length > 1 ? 's' : ''} ${params.map(p => p[1]).join(', ')} at line ${h.line}`);
    }
  }
  return edits.result(notes => `Fixed Python lint violations with their standard rewrite: ${notes.join('; ')} — behaviour is preserved (a mutable default is now created fresh per call, which is what the code intended)`, 93);
}

// ═════════════════════════════════════════════════════════════════════════════
// 14. Imported name exists in the module but is not exported (TS2459 / TS2305)
// ═════════════════════════════════════════════════════════════════════════════

const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

/** Repo path of a relative module specifier imported from `importer`, among `files`. */
export function resolveRelativeModule(files: Files, importer: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const parts = (importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '').split('/').filter(Boolean);
  for (const seg of spec.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const base = parts.join('/').replace(/\.(?:js|jsx|mjs|cjs)$/, '');
  return [base, ...TS_EXT.map(e => base + e)].find(p => files.some(f => f.path === p));
}

/** Relative modules named by "has no exported member" errors — contextBuilder fetches them. */
export function missingExportModules(logs: string): Array<{ importer: string; spec: string }> {
  const out: Array<{ importer: string; spec: string }> = [];
  for (const m of logs.matchAll(/([^\s(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s*error TS(?:2459|2305): Module '"(\.[^"]+)"'/g)) {
    out.push({ importer: normalizeRepoPath(m[1]), spec: m[2] });
  }
  return out;
}

export function fixMissingExport(logs: string, files: Files): RuleFix[] {
  const re = /([^\s(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s*error TS(?:2459|2305): Module '"(\.[^"]+)"' (?:declares '([\w$]+)' locally, but it is not exported|has no exported member '([\w$]+)')/g;
  const edits = new SourceEdits(files);
  for (const m of logs.matchAll(re)) {
    const importer = findFile(files, normalizeRepoPath(m[1]));
    if (!importer) continue;
    const target = resolveRelativeModule(files, importer.path, m[2]);
    if (!target) continue;
    const name = m[3] ?? m[4];
    const lines = edits.lines(target)!;
    const declRe = new RegExp(`^(?:(?:async\\s+)?function\\*?|class|const|let|var|interface|type|enum|abstract\\s+class)\\s+${escapeRe(name)}\\b`);
    const idx = lines.findIndex(l => l !== REMOVED && declRe.test(l));
    // exactly one top-level declaration, and the module does not already export the name some other way
    if (idx < 0 || lines.filter(l => declRe.test(l)).length > 1) continue;
    if (lines.some(l => new RegExp(`^export\\s*\\{[^}]*\\b${escapeRe(name)}\\b`).test(l))) continue;
    lines[idx] = `export ${lines[idx]}`;
    edits.note(target, `'${name}' (imported by ${importer.path})`);
  }
  return edits.result(notes => `Exported ${notes.join(', ')} — the module declares it at top level but never exported it, so the import failed to compile (TS2459/TS2305)`, 94);
}

// ═════════════════════════════════════════════════════════════════════════════
// 15. Python import of a module that moved inside a local package
// ═════════════════════════════════════════════════════════════════════════════
//   ModuleNotFoundError: No module named 'worker.cleanup' while the repo has
//   worker/jobs/cleanup.py (and no worker/cleanup.py) → import worker.jobs.cleanup

/** Local dotted modules that failed to import — contextBuilder looks their files up in the tree. */
export function missingLocalModules(logs: string): string[] {
  return [...new Set([...logs.matchAll(/ModuleNotFoundError: No module named '([\w]+(?:\.[\w]+)+)'/g)].map(m => m[1]))];
}

export function fixPythonModulePath(logs: string, files: Files): RuleFix[] {
  const mods = missingLocalModules(logs);
  if (mods.length === 0) return [];
  const edits = new SourceEdits(files);
  const lines = logs.split('\n');
  for (const mod of mods) {
    const parts = mod.split('.');
    const [top, leaf] = [parts[0], parts[parts.length - 1]];
    // Each file named like the missing leaf, re-expressed as a dotted path from its
    // package root — the deepest directory named `top` above it (services/worker/worker,
    // not the services/worker project folder that merely shares the name).
    const dotted = new Set<string>();
    for (const f of files) {
      if (!f.path.endsWith(`/${leaf}.py`) && !f.path.endsWith(`/${leaf}/__init__.py`)) continue;
      const segs = f.path.split('/');
      const pkgAt = segs.lastIndexOf(top, segs.length - 2);
      if (pkgAt < 0) continue;
      const root = segs.slice(0, pkgAt).join('/');
      // the old path must really be gone — otherwise this is not a relocation
      const oldPath = [root, ...parts].filter(Boolean).join('/');
      if (files.some(x => x.path === `${oldPath}.py` || x.path === `${oldPath}/__init__.py`)) { dotted.clear(); break; }
      dotted.add(segs.slice(pkgAt).join('/').replace(/\/__init__\.py$|\.py$/, '').split('/').join('.'));
    }
    if (dotted.size !== 1) continue; // unknown or ambiguous
    const moved = [...dotted][0];
    if (moved === mod) continue;

    // the importing file: the last repo frame before the error, or pytest's "importing test module"
    const errAt = lines.findIndex(l => l.includes(`No module named '${mod}'`));
    let importer: string | undefined;
    const pytest = logs.match(/ImportError while importing test module '([^']+)'/);
    for (let j = errAt - 1; j >= Math.max(0, errAt - 40) && !importer; j--) {
      const fr = lines[j].match(/File "([^"]+\.py)", line \d+|^\s*([\w./-]+\.py):\d+: in <module>/);
      const p = fr && normalizeRepoPath(fr[1] ?? fr[2]);
      if (p && isRepoRelativeSource(p)) importer = findFile(files, p)?.path;
    }
    importer ??= pytest ? findFile(files, normalizeRepoPath(pytest[1]))?.path : undefined;
    if (!importer) continue;
    const src = edits.lines(importer)!;
    const modRe = new RegExp(`^(\\s*(?:from|import)\\s+)${escapeRe(mod)}(?=\\s|$|,)`);
    let changed = false;
    src.forEach((l, i) => { if (l !== REMOVED && modRe.test(l)) { src[i] = l.replace(modRe, `$1${moved}`); changed = true; } });
    if (changed) edits.note(importer, `${mod} → ${moved}`);
  }
  return edits.result(notes => `Corrected imports of relocated modules: ${notes.join(', ')} — the module lives at that path in the repo; the old dotted path no longer exists`, 94);
}

// ═════════════════════════════════════════════════════════════════════════════
// 16. PyYAML ≥ 6 — yaml.load() requires an explicit Loader
// ═════════════════════════════════════════════════════════════════════════════

export function fixPyYamlLoad(logs: string, files: Files): RuleFix[] {
  if (!/load\(\) missing 1 required positional argument: 'Loader'/.test(logs)) return [];
  const edits = new SourceEdits(files);
  const lines = logs.split('\n');
  lines.forEach((l, i) => {
    if (!/missing 1 required positional argument: 'Loader'/.test(l)) return;
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const fr = lines[j].match(/File "([^"]+\.py)", line (\d+)/);
      const p = fr && normalizeRepoPath(fr[1]);
      if (!p || !isRepoRelativeSource(p)) continue;
      const file = findFile(files, p);
      if (!file) break;
      const src = edits.lines(file.path)!;
      const idx = +fr![2] - 1;
      // single-argument call only — yaml.load(stream) → yaml.safe_load(stream)
      const next = src[idx]?.replace(/\byaml\.load\(([^,()]+)\)/, 'yaml.safe_load($1)');
      if (next && next !== src[idx]) { src[idx] = next; edits.note(file.path, `line ${idx + 1}`); }
      break;
    }
  });
  return edits.result(notes => `Replaced yaml.load(x) with yaml.safe_load(x) (${notes.join(', ')}) — PyYAML 6 made the Loader argument mandatory; safe_load is the drop-in, secure equivalent`, 95);
}
