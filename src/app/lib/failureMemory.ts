// Persistent failure memory: store past CI healing runs + find similar ones via cosine similarity

export interface FailureRecord {
  id: string;
  repoName: string;
  errorContext: string;
  fixes: Array<{ path: string; explanation: string }>;
  embedding: number[];
  timestamp: number;
}

const STORAGE_KEY = 'aegis_failure_memory';
const MAX_RECORDS = 30;

export function saveFailure(record: FailureRecord): void {
  const all = loadAllFailures().filter(r => r.id !== record.id);
  all.unshift(record);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, MAX_RECORDS)));
  } catch { /* storage full — ignore */ }
}

export function loadAllFailures(): FailureRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// Returns the most similar past failure if similarity > threshold
export function findSimilarFailure(
  embedding: number[],
  excludeId?: string,
  threshold = 0.82,
): { record: FailureRecord; similarity: number } | null {
  const candidates = loadAllFailures().filter(
    r => r.id !== excludeId && r.embedding.length > 0,
  );
  if (candidates.length === 0 || embedding.length === 0) return null;
  let best: { record: FailureRecord; similarity: number } | null = null;
  for (const record of candidates) {
    const sim = cosine(embedding, record.embedding);
    if (!best || sim > best.similarity) best = { record, similarity: sim };
  }
  return best && best.similarity >= threshold ? best : null;
}

export function timeAgoMs(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
