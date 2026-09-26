// Strategy 1 — replay a fix that already worked for the same error.
//
// No AI and no embeddings: an error's signature is a hash of its normalised
// error lines + diagnosed categories. A stored fix is replayed only if every
// file it touched is still byte-identical to what it was when the fix worked,
// so the replayed change is exactly the one that turned CI green before.

import type { ProposedFix, RepoFile } from './types';

const STORAGE_KEY = 'aegis_known_fixes';
const MAX_RECORDS = 40;
const MAX_FILE_CHARS = 100_000; // keep localStorage well under its quota

interface KnownFix {
  signature: string;
  repo: string;
  savedAt: number;
  verified: boolean;          // CI was green on the fix branch
  files: Array<{ path: string; beforeHash: string | null; after: string; explanation: string }>;
}

/** 53-bit string hash (cyrb53) — stable, fast, collision-resistant enough for keys. */
export function hash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const ERROR_LINE = /\b(error|fail(ed|ure)?|fatal|exception|traceback|panic|cannot|not found|undefined|denied|refused|invalid)\b/i;

/** Normalise the error lines of a log so the same failure on another run hashes identically. */
export function errorSignature(logs: string, categories: string[]): string {
  const lines = logs.split('\n')
    .filter(l => ERROR_LINE.test(l))
    .map(l => l
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')           // timestamps
      .replace(/\/home\/runner\/work\/[^/]+\/[^/]+\//g, '')    // runner workspace
      .replace(/\/builds\/[^\s]+?\//g, '')
      .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
      .replace(/\d+(\.\d+)*(ms|s|m)?\b/g, '#')                 // numbers, durations, line:col
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean);
  const unique = [...new Set(lines)].slice(0, 12);
  return hash([...categories].sort().join(',') + '\n' + unique.join('\n'));
}

function load(): KnownFix[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(records: KnownFix[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(0, MAX_RECORDS))); } catch { /* quota — memory is best-effort */ }
}

/** Remember a fix (called when a fix PR is opened; `verified` once CI on the fix branch is green). */
export function rememberFix(
  repo: string, signature: string,
  fixes: Array<{ path: string; before: string | null; after: string; explanation: string }>,
  verified: boolean,
): void {
  if (fixes.length === 0 || fixes.some(f => f.after.length > MAX_FILE_CHARS)) return;
  const record: KnownFix = {
    signature, repo, savedAt: Date.now(), verified,
    files: fixes.map(f => ({ path: f.path, beforeHash: f.before === null ? null : hash(f.before), after: f.after, explanation: f.explanation })),
  };
  save([record, ...load().filter(r => !(r.signature === signature && r.repo === repo))]);
}

export function markVerified(repo: string, signature: string): void {
  save(load().map(r => (r.repo === repo && r.signature === signature ? { ...r, verified: true } : r)));
}

/** A stored fix whose files are all still in exactly their pre-fix state, or null. */
export function findKnownFix(repo: string, signature: string, files: RepoFile[]): { fixes: ProposedFix[]; verified: boolean; savedAt: number } | null {
  const byPath = new Map(files.map(f => [f.path, f]));
  // Prefer this repo's own history, and verified fixes over merely-proposed ones.
  const candidates = load()
    .filter(r => r.signature === signature)
    .sort((a, b) => Number(b.repo === repo) - Number(a.repo === repo) || Number(b.verified) - Number(a.verified) || b.savedAt - a.savedAt);
  for (const record of candidates) {
    const applies = record.files.every(f => {
      const current = byPath.get(f.path);
      return f.beforeHash === null ? !current : !!current && hash(current.content) === f.beforeHash;
    });
    if (!applies) continue;
    return {
      verified: record.verified,
      savedAt: record.savedAt,
      fixes: record.files.map(f => ({
        path: f.path, content: f.after, sha: byPath.get(f.path)?.sha ?? '',
        explanation: `Replayed a fix that previously resolved this exact error${record.verified ? ' (CI was green)' : ''}: ${f.explanation}`,
      })),
    };
  }
  return null;
}
