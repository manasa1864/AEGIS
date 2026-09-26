// Dependency-manifest repairs — package.json, requirements*.txt, jest config.
//
// Each fixer is gated on the exact error the package manager / test runner
// printed, and edits the manifest that governs the failing job (the nearest
// one to the file or working directory named in the log), never a guessed
// root file. Versions the registry must supply are written as "latest" (npm)
// or a bare name (pip) and resolved to exact releases by strategies/versions.ts.

import type { RuleFix } from '../helpers';
import { allWorkflowJobs, joinPath, nearestFile } from '../workflowJobs';
import { normalizeRepoPath } from './source';

type Files = Array<{ path: string; content: string }>;

const stripTs = (l: string) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, '');
const REQ_FILE = /(^|\/)requirements[^/]*\.txt$/;
const normPy = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

// ── version helpers ─────────────────────────────────────────────────────────

/** Numeric compare of dotted release versions ("1.20.3" vs "1.18"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Lowest version a declared npm range admits ("^1.18.3" → "1.18.3"), or null for tags/urls. */
function rangeFloor(range: string): string | null {
  const m = range.trim().match(/^(?:[\^~]|>=|=)?\s*v?(\d+(?:\.\d+){0,2})/);
  return m ? m[1] : null;
}

/** Does some release of `major` satisfy the npm-style range? (Only the major matters to setup-node.) */
export function majorSatisfies(range: string, major: number): boolean {
  return range.split('||').some(alt => {
    const comps = alt.trim().split(/\s+/).filter(Boolean);
    if (comps.length === 0) return true;
    return comps.every(c => {
      const m = c.match(/^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/);
      if (!m) return c === '*' || c === 'x';
      const [, op = '', maj, minor] = m;
      const v = +maj;
      const hasMinor = minor !== undefined && minor !== 'x' && minor !== '*' && +minor > 0;
      switch (op) {
        case '>=': return major >= v;
        case '>': return major >= v; // >18.2 is met by a later 18.x
        case '<': return major < v || (major === v && hasMinor);
        case '<=': return major <= v;
        default: return major === v; // ^X, ~X, X, X.x
      }
    });
  });
}

function readJson(content: string): Record<string, unknown> | null {
  try { const v = JSON.parse(content); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
const jsonIndent = (content: string) => content.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? '  ';
const writeJson = (obj: unknown, original: string) =>
  JSON.stringify(obj, null, jsonIndent(original)) + (original.endsWith('\n') ? '\n' : '');

type DepField = 'dependencies' | 'devDependencies' | 'optionalDependencies';
const DEP_FIELDS: DepField[] = ['dependencies', 'devDependencies', 'optionalDependencies'];

/** Repo-relative path a log line names (runner workspace prefix stripped), if it is in `files`. */
function resolveLogPath(files: Files, raw: string): string | undefined {
  const p = normalizeRepoPath(raw);
  return (files.find(f => f.path === p) ?? files.find(f => p.endsWith(`/${f.path}`) || f.path.endsWith(`/${p}`)))?.path;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. A pinned version that does not exist — pip "No matching distribution",
//    npm ETARGET "No matching version found"
// ═════════════════════════════════════════════════════════════════════════════

export function fixUnavailablePinnedVersion(logs: string, files: Files): RuleFix[] {
  const fixes = new Map<string, { content: string; notes: string[] }>();
  const edit = (path: string, original: string) => {
    if (!fixes.has(path)) fixes.set(path, { content: original, notes: [] });
    return fixes.get(path)!;
  };

  // pip prints every published version: pick the newest final release.
  for (const m of logs.matchAll(/Could not find a version that satisfies the requirement ([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*==\s*([^\s(]+)\s*\(from versions: ([^)]*)\)/g)) {
    const [, name, bad, list] = m;
    const releases = list.split(',').map(v => v.trim()).filter(v => /^\d+(?:\.\d+)*$/.test(v));
    if (releases.length === 0) continue; // no such package at all — not a version problem
    const best = releases.sort(compareVersions).at(-1)!;
    const lineRe = new RegExp(`^(\\s*${name.replace(/[-_.]/g, '[-_.]')}(?:\\[[^\\]]*\\])?\\s*)==\\s*${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*(?:;.*|#.*)?)$`, 'im');
    for (const f of files.filter(x => REQ_FILE.test(x.path))) {
      const e = edit(f.path, f.content);
      if (!lineRe.test(e.content)) continue;
      e.content = e.content.replace(lineRe, `$1==${best}$2`);
      e.notes.push(`${name}==${bad} → ${name}==${best} (${bad} was never published; newest release on the index)`);
    }
  }

  // npm: the registry has no such version — let the resolver pin the current release.
  for (const m of logs.matchAll(/No matching version found for (@?[^@\s]+)@([^\s,]+?)\.?(?:\s|$)/g)) {
    const [, name, bad] = m;
    for (const f of files.filter(x => /(^|\/)package\.json$/.test(x.path))) {
      const e = edit(f.path, f.content);
      const pkg = readJson(e.content);
      if (!pkg) continue;
      let hit = false;
      for (const field of DEP_FIELDS) {
        const deps = pkg[field] as Record<string, string> | undefined;
        if (deps?.[name] !== undefined && deps[name].replace(/^[\^~=]/, '') === bad.replace(/^[\^~=]/, '')) { deps[name] = 'latest'; hit = true; }
      }
      if (!hit) continue;
      e.content = writeJson(pkg, f.content);
      e.notes.push(`${name}@${bad} → current release (${bad} does not exist on the registry)`);
    }
  }

  return [...fixes.entries()].filter(([, e]) => e.notes.length).map(([path, e]) => ({
    path, content: e.content, confidence: 92,
    explanation: `Replaced dependency versions that do not exist: ${e.notes.join('; ')} — the install step cannot succeed while the manifest pins an unpublished version`,
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. Old Python pins that no longer build/import on the runner's Python
// ═════════════════════════════════════════════════════════════════════════════
//   • "Failed building wheel for X" / metadata-generation-failed while
//     "Collecting X==old" — no wheel for this Python, source build fails
//   • ImportError raised *inside* an installed package importing another one
//     ("cannot import name 'soft_unicode' from 'markupsafe'" from jinja2) —
//     the importing package is too old for its dependency

export function fixIncompatiblePythonPins(logs: string, files: Files): RuleFix[] {
  const lines = logs.split('\n').map(stripTs);
  const culprits = new Map<string, string>(); // normalized name → reason
  // "Ignored the following versions that require a different python version: 1.19.0 Requires-Python …"
  // + "No matching distribution found for numpy==1.19.0" — the pin exists but not for this Python.
  const ignored = new Set([...logs.matchAll(/require a different python version:\s*([^\n]+)/g)]
    .flatMap(m => [...m[1].matchAll(/(\d+(?:\.\d+)+)\s+Requires-Python/g)].map(v => v[1])));
  for (const m of logs.matchAll(/No matching distribution found for ([A-Za-z0-9][\w.-]*)==([\w.]+)/g)) {
    if (ignored.has(m[2])) culprits.set(normPy(m[1]), `does not support the runner's Python (pip ignored ${m[2]} for its Requires-Python)`);
  }
  let collecting: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const c = l.match(/^\s*Collecting ([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?==/);
    if (c) collecting = c[1];
    const wheel = l.match(/Failed (?:building wheel|to build(?: installable wheels for some pyproject\.toml based projects \()?) (?:for )?([A-Za-z0-9][\w.-]*)/);
    if (wheel) culprits.set(normPy(wheel[1]), 'has no wheel for the runner\'s Python and fails to build from source');
    if (/metadata-generation-failed|Getting requirements to build wheel did not run successfully/.test(l) && collecting) {
      culprits.set(normPy(collecting), 'cannot be built on the runner\'s Python (build metadata failed)');
    }
    const imp = l.match(/ImportError: cannot import name '(\w+)' from '([\w.]+)'/);
    if (imp) {
      // the innermost site-packages frame above the error is the importing package
      for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
        const fr = lines[j].match(/File "[^"]*site-packages\/([A-Za-z0-9_]+)\//);
        if (fr) {
          if (normPy(fr[1]) !== normPy(imp[2].split('.')[0])) culprits.set(normPy(fr[1]), `is too old for the installed ${imp[2]} (it imports '${imp[1]}', which ${imp[2]} removed)`);
          break;
        }
      }
    }
  }
  if (culprits.size === 0) return [];

  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => REQ_FILE.test(x.path))) {
    const notes: string[] = [];
    const content = f.content.split('\n').map(line => {
      const m = line.match(/^(\s*)([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?\s*==\s*([\w.]+)\s*(#.*)?$/);
      if (!m || !culprits.has(normPy(m[2]))) return line;
      notes.push(`${m[2]}==${m[4]} ${culprits.get(normPy(m[2]))}`);
      return `${m[1]}${m[2]}${m[3] ?? ''}`; // bare name → pinned to the current release by the resolver
    }).join('\n');
    if (notes.length) fixes.push({
      path: f.path, content, confidence: 85,
      explanation: `Upgraded incompatible pins: ${notes.join('; ')} — moved to the current release; check its changelog for breaking changes before merging`,
    });
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. Known-vulnerable direct dependencies — npm audit / pip-audit gates
// ═════════════════════════════════════════════════════════════════════════════

export function fixVulnerableDependencies(logs: string, files: Files): RuleFix[] {
  const lines = logs.split('\n').map(stripTs);
  const safeMin = new Map<string, { version: string; breaking: boolean }>(); // npm package → first safe version
  const pySafe = new Map<string, string>();

  if (/npm audit|vulnerabilit/i.test(logs)) {
    // npm's own chosen fixes: "Will install express@4.22.3, which is outside the stated
    // dependency range" / "…, which is a breaking change" — authoritative when present.
    for (const l of lines) {
      const w = l.match(/Will install (@?[^@\s]+)@(\d+\.\d+\.\d+), which is (a breaking change|outside the stated dependency range)/);
      if (w) safeMin.set(w[1], { version: w[2], breaking: w[3].includes('breaking') });
    }
    for (let i = 0; i < lines.length; i++) {
      // advisory header "<name>  <vulnerable range>" (indented when it is a dependent of the
      // package above), followed by its Severity / "Depends on" / fix block
      const h = lines[i].match(/^\s*(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)\s{2,}([<>=^~*\d].*)$/i);
      if (!h || safeMin.has(h[1])) continue;
      const block = lines.slice(i + 1, i + 16);
      const end = block.findIndex(l => !l.trim());
      if (!(end < 0 ? block : block.slice(0, end)).some(l => /^(?:Severity:|Depends on vulnerable versions of|fix available via|No fix available)/i.test(l.trim()))) continue;
      const [, name, range] = h;
      const firstAlt = range.split('||')[0].trim();
      const lt = firstAlt.match(/<\s*(\d+\.\d+\.\d+)$/);
      const lte = firstAlt.match(/<=\s*(\d+)\.(\d+)\.(\d+)$/);
      // the first release above the vulnerable range
      const version = lt ? lt[1] : lte ? `${lte[1]}.${lte[2]}.${+lte[3] + 1}` : null;
      if (version) safeMin.set(name, { version, breaking: false });
    }
  }
  // pip-audit table rows: "<name> <installed> <id> <fix versions>"
  for (const l of lines) {
    const m = l.match(/^([A-Za-z0-9][\w.-]*)\s+(\d[\w.]*)\s+((?:PYSEC|GHSA|CVE)-[\w-]+)\s+(\d[\w.]*(?:\s*,\s*\d[\w.]*)*)\s*$/);
    if (m) {
      const fix = m[4].split(',').map(v => v.trim()).sort(compareVersions)[0];
      const prev = pySafe.get(normPy(m[1]));
      if (!prev || compareVersions(fix, prev) > 0) pySafe.set(normPy(m[1]), fix);
    }
  }
  if (safeMin.size === 0 && pySafe.size === 0) return [];

  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /(^|\/)package\.json$/.test(x.path))) {
    const pkg = readJson(f.content);
    if (!pkg) continue;
    const notes: string[] = [];
    let breaking = false;
    for (const field of DEP_FIELDS) {
      const deps = pkg[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [name, safe] of safeMin) {
        const cur = deps[name];
        const floor = cur !== undefined ? rangeFloor(cur) : null;
        if (!floor || compareVersions(floor, safe.version) >= 0) continue;
        deps[name] = `^${safe.version}`;
        notes.push(`${name} ${cur} → ^${safe.version}${safe.breaking ? ' (major upgrade)' : ''}`);
        breaking ||= safe.breaking;
      }
    }
    if (notes.length) fixes.push({
      path: f.path, content: writeJson(pkg, f.content), confidence: breaking ? 70 : 88,
      explanation: `Upgraded dependencies with published security advisories: ${notes.join(', ')} — the audit gate fails while a direct dependency is in a vulnerable range; each moves to the first patched release${breaking ? '. A major upgrade may need code changes — review before merging' : ''}. Regenerate the lockfile so transitive fixes apply`,
    });
  }
  for (const f of files.filter(x => REQ_FILE.test(x.path))) {
    const notes: string[] = [];
    const content = f.content.split('\n').map(line => {
      const m = line.match(/^(\s*)([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?\s*==\s*([\w.]+)(\s*(?:#.*)?)$/);
      const safe = m && pySafe.get(normPy(m[2]));
      if (!m || !safe || compareVersions(m[4], safe) >= 0) return line;
      notes.push(`${m[2]} ${m[4]} → ${safe}`);
      return `${m[1]}${m[2]}${m[3] ?? ''}==${safe}${m[5]}`;
    }).join('\n');
    if (notes.length) fixes.push({ path: f.path, content, confidence: 85, explanation: `Upgraded Python dependencies with published advisories to their first fixed release: ${notes.join(', ')} — pip-audit fails the build while they stay pinned to vulnerable versions` });
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. Jest test environment that is not installed (jest ≥ 28 ships none)
// ═════════════════════════════════════════════════════════════════════════════

const DOM_DEPS = /^(react-dom|react|vue|svelte|preact|@angular\/core|@testing-library\/(?:dom|react|vue|svelte)|jquery|lit)$/;

/** Also fires without a log: Jest ≥ 28 with a non-'node' environment that is not a
 *  dependency fails on every run, so the config alone proves the failure. */
export function fixJestEnvironmentMissing(logs: string, files: Files): RuleFix[] {
  const m = logs.match(/Test environment (?:jest-environment-)?([\w-]+) cannot be found|"jest-environment-(jsdom)" is no longer shipped by default/);
  const fromLog = m ? (m[1] ?? m[2]) : null;
  const fixes: RuleFix[] = [];
  for (const cfg of files.filter(f => /(^|\/)jest\.config\.[cm]?[jt]s$/.test(f.path))) {
    const setting = cfg.content.match(/testEnvironment\s*:\s*['"](?:jest-environment-)?([\w-]+)['"]/);
    if (!setting || setting[1] === 'node' || (fromLog && setting[1] !== fromLog)) continue;
    const env = setting[1];
    const pkgFile = nearestFile(files, cfg.path, /^package\.json$/);
    const pkg = pkgFile ? readJson(pkgFile.content) : null;
    if (!pkgFile || !pkg) continue;
    const all = Object.assign({}, ...DEP_FIELDS.map(k => (pkg[k] ?? {}) as Record<string, string>));
    if (`jest-environment-${env}` in all) continue;
    const jestMajor = Number(rangeFloor(all.jest ?? '')?.split('.')[0] ?? NaN);
    if (!fromLog && !(jestMajor >= 28)) continue;
    const usesDom = Object.keys(all).some(d => DOM_DEPS.test(d));
    if (env === 'jsdom' && !usesDom) {
      fixes.push({
        path: cfg.path, confidence: 88,
        content: cfg.content.replace(setting[0], setting[0].replace(/['"](?:jest-environment-)?jsdom['"]/, "'node'")),
        explanation: `Set testEnvironment to 'node' in ${cfg.path} — 'jsdom' is not installed (Jest 28+ no longer bundles it) and ${pkgFile.path} has no browser/UI dependency, so the tests need no DOM`,
      });
    } else {
      const devDependencies = { ...((pkg.devDependencies ?? {}) as Record<string, string>), [`jest-environment-${env}`]: 'latest' };
      fixes.push({
        path: pkgFile.path, confidence: 88,
        content: writeJson({ ...pkg, devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b))) }, pkgFile.content),
        explanation: `Added jest-environment-${env} to devDependencies of ${pkgFile.path} — ${cfg.path} selects the '${env}' environment, which Jest 28+ no longer ships`,
      });
    }
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. CI Node version outside the package's engines range
// ═════════════════════════════════════════════════════════════════════════════

export function fixNodeEngineMismatch(logs: string, files: Files): RuleFix[] {
  const logSaysEngine = /EBADENGINE|Unsupported engine|The engine "node" is incompatible|requires a different (?:version of )?Node|Expected version "[^"]+"\. Got "\d/i.test(logs);
  const jobs = allWorkflowJobs(files);
  const numeric = (v: string) => { const m = v.match(/^v?(\d+)(?:\.[\dx*]+)*$/); return m ? +m[1] : null; };
  // majors already used across the repo's workflows — prefer one the project runs elsewhere
  const used = new Map<number, number>();
  for (const j of jobs) for (const nv of j.nodeVersions) { const n = numeric(nv.value); if (n) used.set(n, (used.get(n) ?? 0) + 1); }

  const edits = new Map<string, { lines: string[]; notes: string[] }>();
  for (const job of jobs) {
    if (job.nodeVersions.length === 0) continue;
    const pkgFile = files.find(f => f.path === joinPath(job.workingDirectory, 'package.json'));
    const engines = pkgFile && (readJson(pkgFile.content)?.engines as Record<string, string> | undefined)?.node;
    if (!engines) continue;
    const npmrc = files.find(f => f.path === joinPath(job.workingDirectory, '.npmrc'));
    if (!logSaysEngine && !(npmrc && /^\s*engine-strict\s*=\s*true/m.test(npmrc.content))) continue;
    // Matrix legs: drop the Node versions the package does not support (keep the rest).
    const wfLines = files.find(f => f.path === job.path)!.content.split('\n');
    for (let i = job.start; i < job.end; i++) {
      const mx = wfLines[i].match(/^(\s*)(node|node-version|node_version|node-versions)(:\s*)\[([^\]]+)\](.*)$/);
      if (!mx || !wfLines.slice(job.start, i).some(l => /^\s*matrix:\s*$/.test(l))) continue;
      const legs = mx[4].split(',').map(s => s.trim());
      const keep = legs.filter(l => { const n = numeric(l.replace(/['"]/g, '')); return n === null || majorSatisfies(engines, n); });
      if (keep.length === legs.length || keep.length === 0) continue;
      if (!edits.has(job.path)) edits.set(job.path, { lines: wfLines.slice(), notes: [] });
      const e = edits.get(job.path)!;
      e.lines[i] = `${mx[1]}${mx[2]}${mx[3]}[${keep.join(', ')}]${mx[5]}`;
      e.notes.push(`job "${job.id}" matrix drops ${legs.filter(l => !keep.includes(l)).join(', ')} (${pkgFile!.path} requires node ${engines})`);
    }
    for (const nv of job.nodeVersions) {
      const major = numeric(nv.value);
      if (major === null || majorSatisfies(engines, major)) continue;
      const candidates = [...used.entries()].filter(([m]) => majorSatisfies(engines, m)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      let target = candidates[0]?.[0];
      for (let m = major + 1; target === undefined && m <= major + 12; m++) if (m % 2 === 0 && majorSatisfies(engines, m)) target = m;
      if (target === undefined) continue;
      const wf = files.find(f => f.path === job.path)!;
      if (!edits.has(job.path)) edits.set(job.path, { lines: wf.content.split('\n'), notes: [] });
      const e = edits.get(job.path)!;
      e.lines[nv.line] = e.lines[nv.line].replace(/(node-version:\s*)(['"]?)[^'"\s#]+\2/, `$1$2${target}$2`);
      e.notes.push(`job "${job.id}" ${nv.value} → ${target} (${pkgFile!.path} requires node ${engines})`);
    }
  }
  return [...edits.entries()].map(([path, e]) => ({
    path, content: e.lines.join('\n'), confidence: 95,
    explanation: `Aligned CI Node versions with package.json engines: ${e.notes.join('; ')} — npm refuses to install (EBADENGINE) when the runner's Node is outside the declared range`,
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. `pip install -r <file>` naming a file that does not exist
// ═════════════════════════════════════════════════════════════════════════════

export function fixMissingRequirementsFile(logs: string, files: Files): RuleFix[] {
  const missing = [...logs.matchAll(/Could not open requirements file: \[Errno 2\] No such file or directory: '([^']+)'/g)].map(m => m[1]);
  if (missing.length === 0) return [];
  const fixes: RuleFix[] = [];
  const seen = new Set<string>();
  for (const job of allWorkflowJobs(files)) {
    for (const run of job.runs) {
      for (const m of run.matchAll(/pip3?\s+install\s+(?:[^\n]*\s)?-r\s+([^\s;&|]+)/g)) {
        if (!missing.includes(m[1])) continue;
        const path = joinPath(job.workingDirectory, m[1]);
        if (seen.has(path) || files.some(f => f.path === path)) continue;
        seen.add(path);
        fixes.push({
          path, confidence: 80,
          content: '# Python dependencies for this CI job — pin exact versions (name==x.y.z)\n',
          explanation: `Created ${path} — job "${job.id}" runs pip install -r ${m[1]} in ${job.workingDirectory || 'the repo root'} and pip reported the file does not exist; add the job's dependencies to it`,
        });
      }
    }
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. A job activates a virtualenv that no step ever creates
// ═════════════════════════════════════════════════════════════════════════════

export function fixVirtualenvNotCreated(logs: string, files: Files): RuleFix[] {
  const missing = [...logs.matchAll(/([\w./-]*?)\/?(\.?venv|env|\.env)\/bin\/activate: No such file or directory/g)]
    .map(m => (m[1] ? `${m[1]}/${m[2]}` : m[2]).replace(/^.*\/_temp\/[^/]*\//, ''));
  if (missing.length === 0) return [];
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /\.github\/workflows\//.test(x.path))) {
    let content = f.content;
    const notes: string[] = [];
    for (const job of allWorkflowJobsOf(f).reverse()) { // last job first — insertions must not shift pending ranges
      const lines = content.split('\n');
      for (const venv of new Set(missing)) {
        const act = new RegExp(`(?:source|\\.)\\s+(?:\\./)?${venv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/bin/activate`);
        const creates = new RegExp(`(?:-m\\s+venv|virtualenv|uv\\s+venv)\\s+(?:\\./)?${venv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (!job.runs.some(r => act.test(r)) || job.runs.some(r => creates.test(r))) continue;
        // the step (list item) whose run: activates the venv
        let stepAt = -1;
        for (let i = job.start; i < job.end && stepAt < 0; i++) {
          if (!act.test(lines[i])) continue;
          for (let k = i; k > job.start; k--) if (/^\s+- /.test(lines[k])) { stepAt = k; break; }
        }
        if (stepAt < 0) continue;
        const indent = lines[stepAt].match(/^(\s*)-/)![1];
        const reqs = files.find(x => x.path === joinPath(job.workingDirectory, 'requirements.txt'));
        const step = [
          `${indent}- name: Create virtual environment`,
          `${indent}  run: |`,
          `${indent}    python3 -m venv ${venv}`,
          ...(reqs ? [`${indent}    ${venv}/bin/pip install -r requirements.txt`] : []),
        ];
        if (job.workingDirectory && !/working-directory/.test(lines.slice(job.start, job.end).join('\n'))) step.splice(1, 0, `${indent}  working-directory: ${job.workingDirectory}`);
        lines.splice(stepAt, 0, ...step);
        content = lines.join('\n');
        notes.push(`job "${job.id}" activates ${venv} but never created it`);
        break;
      }
    }
    if (notes.length) fixes.push({
      path: f.path, content, confidence: 92,
      explanation: `Added a step that creates the virtualenv before it is activated (${notes.join('; ')}) — a fresh runner has no ${missing[0]} directory, so "source ${missing[0]}/bin/activate" fails`,
    });
  }
  return fixes;
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. upload-artifact path that is not where the build writes its output
// ═════════════════════════════════════════════════════════════════════════════

/** Output directory of the package in `dir`, from its build tool's own config — null when unknown/ambiguous. */
export function buildOutputDir(files: Files, dir: string): string | null {
  const at = (name: string) => files.find(f => f.path === joinPath(dir, name));
  const pkg = at('package.json') && readJson(at('package.json')!.content);
  const deps = pkg ? Object.assign({}, ...DEP_FIELDS.map(k => (pkg[k] ?? {}) as Record<string, string>)) : {};
  const build = String(((pkg?.scripts ?? {}) as Record<string, string>).build ?? '');
  const found = new Set<string>();
  const vite = files.find(f => new RegExp(`^${dir ? `${dir}/` : ''}vite\\.config\\.[cm]?[jt]s$`).test(f.path));
  if (vite || /\bvite\s+build\b/.test(build)) found.add(vite?.content.match(/outDir\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? 'dist');
  if (/\breact-scripts\s+build\b/.test(build)) found.add('build');
  if (/\bnext\s+build\b/.test(build)) found.add(/output\s*:\s*['"]export['"]/.test(files.find(f => /next\.config\.[cm]?[jt]s$/.test(f.path))?.content ?? '') ? 'out' : '.next');
  if (/\btsc\b/.test(build) && !found.size) {
    const tsconfig = at('tsconfig.json')?.content ?? at('tsconfig.build.json')?.content ?? '';
    const out = tsconfig.match(/"outDir"\s*:\s*"([^"]+)"/)?.[1];
    if (out) found.add(out);
  }
  const webpack = at('webpack.config.js')?.content.match(/path\.resolve\(__dirname,\s*['"]([^'"]+)['"]\)/)?.[1];
  if (webpack && /\bwebpack\b/.test(build)) found.add(webpack);
  if (found.size === 0 && 'parcel' in deps && /\bparcel\s+build\b/.test(build)) found.add('dist');
  if (found.size !== 1) return null;
  return joinPath(dir, [...found][0].replace(/^\.\//, '').replace(/\/+$/, ''));
}

export function fixArtifactPathMismatch(logs: string, files: Files): RuleFix[] {
  const missing = [...logs.matchAll(/No files were found with the provided path: ([^\s.]+(?:\.[^\s.]+)*)\.?\s/g)].map(m => m[1].replace(/\/+$/, ''));
  if (missing.length === 0) return [];
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /\.github\/workflows\//.test(x.path))) {
    const lines = f.content.split('\n');
    const notes: string[] = [];
    for (const job of allWorkflowJobs([f])) {
      const out = buildOutputDir(files, job.workingDirectory);
      if (!out) continue;
      for (let i = job.start; i < job.end; i++) {
        const m = lines[i].match(/^(\s*path:\s*)(['"]?)([^'"#\s]+?)\/?\2(\s*(?:#.*)?)$/);
        if (!m || !missing.includes(m[3]) || m[3] === out) continue;
        // only the path of an upload-artifact step
        let k = i; while (k > job.start && !/^\s*- /.test(lines[k])) k--;
        if (!lines.slice(k, i).some(l => /uses:\s*actions\/upload-artifact@/.test(l))) continue;
        lines[i] = `${m[1]}${m[2]}${out}/${m[2]}${m[4]}`;
        notes.push(`${m[3]}/ → ${out}/ (job "${job.id}")`);
      }
    }
    if (notes.length) fixes.push({
      path: f.path, content: lines.join('\n'), confidence: 90,
      explanation: `Pointed upload-artifact at the directory the build actually writes: ${notes.join(', ')} — the build tool's own config sets that output directory, so the old path was always empty`,
    });
  }
  return fixes;
}

/** Jobs of one workflow, re-scanned from its current content. */
const allWorkflowJobsOf = (f: { path: string; content: string }) => allWorkflowJobs([f]);

// ═════════════════════════════════════════════════════════════════════════════
// 8. Missing npm packages — declared in the package that imports them
// ═════════════════════════════════════════════════════════════════════════════

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram',
  'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module',
  'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib', 'test',
]);

export function packageName(spec: string): string | null {
  if (!spec || /^[./~#]|^@\/|^node:|^[a-z]+:/i.test(spec)) return null; // relative, alias, builtin scheme, url
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) || NODE_BUILTINS.has(name)) return null;
  return name;
}

interface MissingImport {
  name: string;
  /** Repo path of the importing file (or its directory + '/_'), when the log names one we can place. */
  from?: string;
  /** `from` is a file present in the context (safe to edit). */
  inContext?: boolean;
}

/** Place a path printed by a tool: absolute runner paths are repo-relative once the workspace
 *  prefix is stripped; cwd-relative ones (tsc, eslint) are matched against the fetched files. */
function placeLogPath(files: Files, raw: string, isDir = false): Pick<MissingImport, 'from' | 'inContext'> {
  const inCtx = isDir ? undefined : resolveLogPath(files, raw);
  if (inCtx) return { from: inCtx, inContext: true };
  const p = normalizeRepoPath(raw);
  const wasAbsolute = /^(?:\/|[A-Za-z]:[\\/])/.test(raw.trim()) && !/^(?:\/|[A-Za-z]:)/.test(p);
  return wasAbsolute ? { from: isDir ? `${p}/_` : p } : {};
}

function collectMissingImports(logs: string, files: Files): MissingImport[] {
  const out: MissingImport[] = [];
  for (const raw of logs.split('\n').map(stripTs)) {
    let m: RegExpMatchArray | null;
    // TS2307 / TS7016 carry the importing file: "src/a.ts(2,22): error TS2307: Cannot find module 'x' …"
    if ((m = raw.match(/([^\s(]+\.[cm]?[jt]sx?)\(\d+,\d+\):\s*error TS(?:2307|7016): (?:Cannot find module|Could not find a declaration file for module) '([^']+)'/))) { out.push({ name: m[2], ...placeLogPath(files, m[1]) }); continue; }
    if ((m = raw.match(/Cannot find (?:module|package) '([^']+)'(?! or its corresponding type declarations)(?:.*?imported from (\S+))?/))) { out.push({ name: m[1], ...(m[2] ? placeLogPath(files, m[2]) : {}) }); continue; }
    if ((m = raw.match(/Can't resolve '([^']+)' in '([^']+)'/))) { out.push({ name: m[1], ...placeLogPath(files, m[2], true) }); continue; }
    if ((m = raw.match(/Failed to resolve import "([^"]+)" from "([^"]+)"/))) { out.push({ name: m[1], ...placeLogPath(files, m[2]) }); continue; }
    if ((m = raw.match(/Could not resolve "([^"]+)"/))) out.push({ name: m[1] });
  }
  return out;
}

export function fixMissingNpmPackage(logs: string, files: Files): RuleFix[] {
  const found = collectMissingImports(logs, files);
  if (found.length === 0) return [];
  const manifests = files.filter(f => /(^|\/)package\.json$/.test(f.path));
  if (manifests.length === 0) return [];

  const perManifest = new Map<string, { runtime: Set<string>; types: Set<string> }>();
  const renames = new Map<string, Array<{ from: string; to: string }>>(); // importing file → specifier swaps
  for (const miss of found) {
    const name = packageName(miss.name);
    if (!name) continue;
    // The manifest governing the importing file; with several packages and no
    // placeable importer, guessing the root one would declare it in the wrong package.
    const pkgFile = (miss.from && nearestFile(manifests, miss.from, /^package\.json$/)) || (manifests.length === 1 ? manifests[0] : undefined);
    const pkg = pkgFile && readJson(pkgFile.content);
    if (!pkgFile || !pkg) continue;
    const declared = Object.assign({}, ...DEP_FIELDS.map(k => (pkg[k] ?? {}) as Record<string, string>), (pkg.peerDependencies ?? {}) as Record<string, string>);
    if (!perManifest.has(pkgFile.path)) perManifest.set(pkgFile.path, { runtime: new Set(), types: new Set() });
    const bucket = perManifest.get(pkgFile.path)!;
    if (name in declared) {
      // installed, but its type declarations are not
      if (/TS2307|TS7016/.test(logs) && !name.startsWith('@types/')) {
        const typesPkg = name.startsWith('@') ? `@types/${name.slice(1).replace('/', '__')}` : `@types/${name}`;
        if (!(typesPkg in declared)) bucket.types.add(typesPkg);
      }
      continue;
    }
    // The project already depends on exactly one variant of this package
    // (@vitejs/plugin-react vs @vitejs/plugin-react-swc) — import that instead.
    const variants = Object.keys(declared).filter(d => d.startsWith(`${name}-`));
    if (miss.from && miss.inContext && variants.length === 1) {
      if (!renames.has(miss.from)) renames.set(miss.from, []);
      renames.get(miss.from)!.push({ from: name, to: variants[0] });
      continue;
    }
    bucket.runtime.add(name);
  }

  const fixes: RuleFix[] = [];
  for (const [path, swaps] of renames) {
    const f = files.find(x => x.path === path)!;
    let content = f.content;
    for (const s of swaps) content = content.replace(new RegExp(`(['"])${s.from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\1`, 'g'), `$1${s.to}$1`);
    if (content !== f.content) fixes.push({
      path, content, confidence: 85,
      explanation: `Imported the package variant the project actually depends on: ${swaps.map(s => `'${s.from}' → '${s.to}'`).join(', ')} — '${swaps[0].from}' is not installed, while its variant is declared in package.json`,
    });
  }
  const sortObj = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  for (const [path, { runtime, types }] of perManifest) {
    if (runtime.size === 0 && types.size === 0) continue;
    const pkgFile = files.find(f => f.path === path)!;
    const pkg = readJson(pkgFile.content)!;
    const next = { ...pkg };
    if (runtime.size) next.dependencies = sortObj({ ...((pkg.dependencies ?? {}) as Record<string, string>), ...Object.fromEntries([...runtime].map(n => [n, 'latest'])) });
    if (types.size) next.devDependencies = sortObj({ ...((pkg.devDependencies ?? {}) as Record<string, string>), ...Object.fromEntries([...types].map(n => [n, 'latest'])) });
    const added = [...runtime, ...types];
    fixes.push({
      path, content: writeJson(next, pkgFile.content), confidence: 85,
      explanation: `Declared missing package${added.length > 1 ? 's' : ''} ${added.join(', ')} in ${path} — the code imports ${added.length > 1 ? 'them' : 'it'} but ${added.length > 1 ? 'they were' : 'it was'} never added, so installs on a clean runner cannot resolve the import. Pinned to "latest": replace with the exact version and regenerate the lockfile before merging`,
    });
  }
  return fixes;
}
