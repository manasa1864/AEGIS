// Pins dependencies that fixes added without a version ("latest" in package.json,
// a bare name in requirements.txt) to the registry's current release — a
// deterministic lookup, not a guess. Falls back to leaving the fix unchanged.

import type { ProposedFix, RepoFile } from './types';

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function npmLatest(name: string): Promise<string | null> {
  const d = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`);
  return typeof d?.version === 'string' ? d.version : null;
}

export async function pypiLatest(name: string): Promise<string | null> {
  const d = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  const info = d?.info as { version?: string } | undefined;
  return typeof info?.version === 'string' ? info.version : null;
}

export async function pinResolvedVersions(
  fixes: ProposedFix[], originals: RepoFile[],
): Promise<{ fixes: ProposedFix[]; pinned: string[]; unresolved: string[] }> {
  const pinned: string[] = [];
  const unresolved: string[] = [];
  const out: ProposedFix[] = [];

  for (const fix of fixes) {
    if (/(^|\/)package\.json$/.test(fix.path)) {
      let pkg: Record<string, Record<string, string> | unknown>;
      try { pkg = JSON.parse(fix.content); } catch { out.push(fix); continue; }
      let changed = false;
      for (const field of ['dependencies', 'devDependencies'] as const) {
        const deps = pkg[field] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const [name, range] of Object.entries(deps)) {
          if (range !== 'latest' && range !== '*') continue;
          const version = await npmLatest(name);
          if (version) { deps[name] = `^${version}`; pinned.push(`${name}@^${version}`); changed = true; }
          else unresolved.push(name);
        }
      }
      if (!changed) { out.push(fix); continue; }
      const indent = fix.content.match(/^\{\n([ \t]+)"/)?.[1] ?? '  ';
      out.push({
        ...fix,
        content: JSON.stringify(pkg, null, indent) + '\n',
        explanation: `${fix.explanation.replace(/ Pinned to "latest"[^.]*\.?/, '')} Versions resolved from the npm registry: ${pinned.join(', ')}.`,
      });
      continue;
    }

    if (/(^|\/)requirements[^/]*\.txt$/.test(fix.path)) {
      const before = new Set((originals.find(o => o.path === fix.path)?.content ?? '').split('\n').map(l => l.trim()));
      const lines = fix.content.split('\n');
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // only lines this fix added, and only bare names with no version spec
        if (!line || before.has(line) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line)) continue;
        const version = await pypiLatest(line);
        if (version) { lines[i] = `${line}==${version}`; pinned.push(`${line}==${version}`); changed = true; }
        else unresolved.push(line);
      }
      out.push(changed ? { ...fix, content: lines.join('\n'), explanation: `${fix.explanation.replace(/;? ?pin a version before merging/, '')} Versions resolved from PyPI: ${pinned.filter(p => p.includes('==')).join(', ')}.` } : fix);
      continue;
    }

    out.push(fix);
  }
  return { fixes: out, pinned, unresolved };
}

/** Does this set of fixes change declared npm dependencies (so the lockfile must be refreshed)? */
export function changesNpmDependencies(fixes: ProposedFix[], originals: RepoFile[]): boolean {
  return fixes.some(f => {
    if (!/(^|\/)package\.json$/.test(f.path)) return false;
    const orig = originals.find(o => o.path === f.path)?.content;
    try {
      const a = orig ? JSON.parse(orig) : {};
      const b = JSON.parse(f.content);
      return JSON.stringify([a.dependencies, a.devDependencies]) !== JSON.stringify([b.dependencies, b.devDependencies]);
    } catch {
      return false;
    }
  });
}
