// Infrastructure manifest repairs.
//
// Static — the definition is guaranteed to be rejected, so no log is needed:
//   • docker-compose: two services publishing the same host port
//     ("Bind for 0.0.0.0:PORT failed: port is already allocated")
//   • Kubernetes workloads whose selector does not match the pod template labels
//     ("`selector` does not match template `labels`")
// Log-gated — the build error names the problem:
//   • docker build looking for ./Dockerfile when the repo's only Dockerfile is elsewhere
//   • Dockerfile instructions the parser rejects (glued or misspelled keywords)

import yaml from 'js-yaml';
import type { RuleFix } from '../helpers';

type Files = Array<{ path: string; content: string }>;

const isCompose = (p: string) => /(^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(p);
const indentOf = (l: string) => l.length - l.trimStart().length;

/** [start, end) line range of the child block `key:` under the block starting at `from` with child indent `ind`. */
function childBlock(lines: string[], from: number, to: number, key: string): [number, number] | null {
  for (let i = from; i < to; i++) {
    const m = lines[i].match(/^(\s*)([\w.-]+):\s*(#.*)?$/);
    if (!m || m[2] !== key) continue;
    const ind = m[1].length;
    let end = i + 1;
    while (end < to && (!lines[end].trim() || indentOf(lines[end]) > ind)) end++;
    return [i, end];
  }
  return null;
}

// ── docker-compose host-port collisions ─────────────────────────────────────

function hostPortOf(mapping: string): { host: string; rest: string; prefix: string } | null {
  // [ip:]host:container[/proto]
  const m = mapping.match(/^((?:\d{1,3}(?:\.\d{1,3}){3}|\[[^\]]+\]):)?(\d+):(\d+(?:-\d+)?(?:\/\w+)?)$/);
  return m ? { prefix: m[1] ?? '', host: m[2], rest: m[3] } : null;
}

export function fixComposeHostPortCollision(files: Files): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => isCompose(x.path))) {
    let doc: { services?: Record<string, { ports?: unknown[] }> };
    try { doc = yaml.loadAll(f.content)[0] as typeof doc; } catch { continue; }
    if (!doc?.services) continue;
    const owner = new Map<string, string>(); // host port → first service
    const clashes: Array<{ service: string; mapping: string; host: string }> = [];
    for (const [name, svc] of Object.entries(doc.services)) {
      for (const p of svc?.ports ?? []) {
        if (typeof p !== 'string' && typeof p !== 'number') continue;
        const hp = hostPortOf(String(p));
        if (!hp) continue;
        const key = `${hp.prefix}${hp.host}`;
        if (owner.has(key) && owner.get(key) !== name) clashes.push({ service: name, mapping: String(p), host: hp.host });
        else owner.set(key, name);
      }
    }
    if (clashes.length === 0) continue;

    const lines = f.content.split('\n');
    const services = childBlock(lines, 0, lines.length, 'services');
    if (!services) continue;
    const used = new Set([...owner.keys()].map(k => k.replace(/^.*:/, '')));
    const notes: string[] = [];
    for (const c of clashes) {
      const block = childBlock(lines, services[0] + 1, services[1], c.service);
      if (!block) continue;
      let free = +c.host + 1;
      while (used.has(String(free))) free++;
      const hp = hostPortOf(c.mapping)!;
      const replacement = `${hp.prefix}${free}:${hp.rest}`;
      for (let i = block[0]; i < block[1]; i++) {
        const re = new RegExp(`^(\\s*-\\s*)(['"]?)${c.mapping.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2(\\s*(?:#.*)?)$`);
        if (!re.test(lines[i])) continue;
        lines[i] = lines[i].replace(re, `$1$2${replacement}$2$3`);
        used.add(String(free));
        notes.push(`${c.service}: ${c.mapping} → ${replacement} (host port ${c.host} is already published by ${owner.get(`${hp.prefix}${c.host}`)})`);
        break;
      }
    }
    if (notes.length) fixes.push({
      path: f.path, content: lines.join('\n'), confidence: 85,
      explanation: `Resolved host-port collisions in ${f.path}: ${notes.join('; ')} — two services cannot bind the same host port; compose fails with "port is already allocated". The first service keeps the port; update any client that used the moved one`,
    });
  }
  return fixes;
}

// ── docker build pointed at a Dockerfile that is not where it looks ─────────
// "failed to read dockerfile: open Dockerfile: no such file or directory" while
// the repo has exactly one Dockerfile elsewhere → build with -f <that file>.
// (Log-gated: the error proves the default location is wrong.)

const DOCKERFILE_NAME = /(?:^|\/)(?:Dockerfile(?:\.[\w-]+)?|[\w-]+\.Dockerfile)$/;

export function fixDockerfilePath(logs: string, files: Files): RuleFix[] {
  if (!/failed to read dockerfile: open (?:\S*\/)?Dockerfile: no such file|unable to prepare context: unable to evaluate symlinks in Dockerfile path|Cannot locate specified Dockerfile/i.test(logs)) return [];
  const candidates = files.filter(f => DOCKERFILE_NAME.test(f.path));
  if (candidates.length !== 1) return []; // none (needs authoring) or ambiguous (needs a human)
  const dockerfile = candidates[0].path;
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /\.github\/workflows\/|gitlab-ci/.test(x.path))) {
    let content = f.content.replace(/(docker(?:\s+buildx)?\s+build)(?![^\n]*\s(?:-f|--file)[\s=])(?=[^\n]*\s\.\s*(?:$|&&|;|\|))/gm, `$1 -f ${dockerfile}`);
    // docker/build-push-action with the default file
    content = content.replace(/(uses:\s*docker\/build-push-action@[^\n]+\n(\s+)with:\n)(?![\s\S]*?^\2\s+file:)/m, `$1$2  file: ${dockerfile}\n`);
    if (content !== f.content) fixes.push({
      path: f.path, content, confidence: 90,
      explanation: `Pointed docker build at ${dockerfile} (-f) — the build looked for ./Dockerfile, which does not exist; ${dockerfile} is the only Dockerfile in the repo`,
    });
  }
  return fixes;
}

// ── Dockerfile instruction the parser does not know ─────────────────────────
// "dockerfile parse error on line 5: unknown instruction: CMD["node","
//   • keyword glued to its JSON array (CMD["node"]) → CMD ["node"]
//   • misspelled keyword one edit away from a real one (RUNN, COPPY) → corrected

const INSTRUCTIONS = ['FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL'];

function editDistance1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

export function fixDockerfileUnknownInstruction(logs: string, files: Files): RuleFix[] {
  const errs = [...logs.matchAll(/dockerfile parse error (?:on )?line (\d+): unknown instruction: (\S+)/gi)];
  if (errs.length === 0) return [];
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => DOCKERFILE_NAME.test(x.path))) {
    const lines = f.content.split('\n');
    const notes: string[] = [];
    for (const [, lineNo, bad] of errs) {
      const idx = +lineNo - 1;
      const line = lines[idx];
      if (line === undefined || !line.trimStart().toUpperCase().startsWith(bad.toUpperCase().slice(0, 2))) continue;
      const glued = line.match(/^(\s*)([A-Za-z]+)(\[.*)$/);
      if (glued && INSTRUCTIONS.includes(glued[2].toUpperCase())) {
        lines[idx] = `${glued[1]}${glued[2].toUpperCase()} ${glued[3]}`;
        notes.push(`line ${lineNo}: space between ${glued[2].toUpperCase()} and its arguments`);
        continue;
      }
      const word = line.match(/^(\s*)([A-Za-z]+)(\s.*)?$/);
      const near = word && INSTRUCTIONS.filter(i => editDistance1(word[2].toUpperCase(), i));
      if (word && near && near.length === 1) {
        lines[idx] = `${word[1]}${near[0]}${word[3] ?? ''}`;
        notes.push(`line ${lineNo}: ${word[2]} → ${near[0]}`);
      }
    }
    if (notes.length) fixes.push({
      path: f.path, content: lines.join('\n'), confidence: 95,
      explanation: `Fixed Dockerfile instructions the parser rejected (${notes.join('; ')}) — docker build stops at the first unknown instruction`,
    });
  }
  return fixes;
}

// ── compose bind mount whose host path does not exist on the runner ─────────
// "bind source path does not exist: /data" → the service gets a named volume
// (created by compose) instead of a host directory that CI machines do not have.

export function fixMissingBindSource(logs: string, files: Files): RuleFix[] {
  const sources = [...logs.matchAll(/bind source path does not exist:\s*(\/[\w./-]+)/g)].map(m => m[1].replace(/\/+$/, ''));
  if (sources.length === 0) return [];
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => isCompose(x.path))) {
    const lines = f.content.split('\n');
    const named: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*-\s*)(['"]?)(\/[\w./-]+?)\/?:([^'"\s]+)\2(\s*(?:#.*)?)$/);
      if (!m || !sources.includes(m[3])) continue;
      const name = `${m[3].split('/').filter(Boolean).pop()!.replace(/[^\w-]/g, '-')}-data`;
      lines[i] = `${m[1]}${m[2]}${name}:${m[4]}${m[2]}${m[5]}`;
      if (!named.includes(name)) named.push(name);
    }
    if (named.length === 0) continue;
    let content = lines.join('\n');
    const top = content.match(/^volumes:\s*(?:\{\s*\})?\s*$/m);
    const decl = named.map(n => `  ${n}:`).join('\n');
    if (top) content = content.replace(/^volumes:\s*(?:\{\s*\})?\s*$/m, `volumes:\n${decl}`);
    else content = `${content.replace(/\n*$/, '')}\n\nvolumes:\n${decl}\n`;
    fixes.push({
      path: f.path, content, confidence: 85,
      explanation: `Replaced host bind mount${named.length > 1 ? 's' : ''} ${sources.join(', ')} with named volume${named.length > 1 ? 's' : ''} ${named.join(', ')} — the host directory does not exist on the runner, so the container could not start; compose creates named volumes itself. Keep the bind mount in a local override file if you need host data`,
    });
  }
  return fixes;
}

// ── rollback impossible because the workload keeps no revision history ───────
// "no rollout history found" / "unable to find specified revision" while the
// Deployment sets revisionHistoryLimit: 0 → keep Kubernetes' default of 10.

export function fixZeroRevisionHistory(logs: string, files: Files): RuleFix[] {
  if (!/no rollout history found|unable to find specified revision|could not find (?:the requested )?revision/i.test(logs)) return [];
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /\.ya?ml$/.test(x.path) && /^kind:\s*(?:Deployment|StatefulSet|DaemonSet)\s*$/m.test(x.content))) {
    const content = f.content.replace(/^(\s*revisionHistoryLimit:\s*)0\s*$/gm, '$110');
    if (content !== f.content) fixes.push({
      path: f.path, content, confidence: 92,
      explanation: `Restored revisionHistoryLimit to 10 in ${f.path} — with 0 Kubernetes deletes every old ReplicaSet, so "kubectl rollout undo" has no revision to return to`,
    });
  }
  return fixes;
}

// ── Kubernetes selector ↔ template label mismatch ───────────────────────────

const WORKLOADS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet']);

export function fixK8sSelectorLabelMismatch(files: Files): RuleFix[] {
  const fixes: RuleFix[] = [];
  for (const f of files.filter(x => /\.ya?ml$/.test(x.path))) {
    if (!/^kind:\s*(?:Deployment|StatefulSet|DaemonSet|ReplicaSet)\s*$/m.test(f.content)) continue;
    let docs: unknown[];
    try { docs = yaml.loadAll(f.content); } catch { continue; }
    // pods that Services in this file select — relabelling them would orphan the Service
    const serviceSelectors = docs.filter((d): d is { kind: string; spec?: { selector?: Record<string, string> } } => (d as { kind?: string })?.kind === 'Service')
      .map(d => d.spec?.selector ?? {});

    const lines = f.content.split('\n');
    const docStarts = [0, ...lines.map((l, i) => (l.trim() === '---' ? i + 1 : -1)).filter(i => i > 0)];
    const notes: string[] = [];
    // last document first — inserting a label line must not shift the ranges of pending ones
    for (let di = docs.length - 1; di >= 0; di--) {
      const doc = docs[di] as { kind?: string; metadata?: { name?: string }; spec?: { selector?: { matchLabels?: Record<string, string> }; template?: { metadata?: { labels?: Record<string, string> } } } };
      if (!doc || !WORKLOADS.has(doc.kind ?? '')) continue;
      const want = doc.spec?.selector?.matchLabels ?? {};
      const have = doc.spec?.template?.metadata?.labels ?? {};
      const wrong = Object.entries(want).filter(([k, v]) => String(have[k]) !== String(v));
      if (wrong.length === 0) continue;
      if (serviceSelectors.some(sel => wrong.some(([k]) => have[k] !== undefined && sel[k] === have[k]))) continue;

      const start = docStarts[di] ?? 0;
      const end = docStarts[di + 1] !== undefined ? docStarts[di + 1] - 1 : lines.length;
      const spec = childBlock(lines, start, end, 'spec');
      const template = spec && childBlock(lines, spec[0] + 1, spec[1], 'template');
      const meta = template && childBlock(lines, template[0] + 1, template[1], 'metadata');
      const labels = meta && childBlock(lines, meta[0] + 1, meta[1], 'labels');
      if (!labels) continue;
      const labelIndent = lines.slice(labels[0] + 1, labels[1]).find(l => l.trim())?.match(/^\s*/)?.[0] ?? `${lines[labels[0]].match(/^\s*/)![0]}  `;
      for (const [k, v] of wrong) {
        const at = lines.findIndex((l, i) => i > labels[0] && i < labels[1] && new RegExp(`^\\s*${k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:`).test(l));
        if (at >= 0) lines[at] = `${labelIndent}${k}: ${v}`;
        else lines.splice(labels[0] + 1, 0, `${labelIndent}${k}: ${v}`);
      }
      notes.push(`${doc.kind} ${doc.metadata?.name ?? ''}: template labels now include ${wrong.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }
    if (notes.length) fixes.push({
      path: f.path, content: lines.join('\n'), confidence: 90,
      explanation: `Aligned pod template labels with the workload selector (${notes.join('; ')}) — the API server rejects a workload whose spec.selector does not match spec.template.metadata.labels, so kubectl apply fails`,
    });
  }
  return fixes;
}
