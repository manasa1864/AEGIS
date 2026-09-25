// Line-level diff shared by the healing UI (per-fix before/after view) and the
// fix-catalog generator (unified .diff files). Pure and dependency-free.

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  oldNo?: number; // 1-based line number in the old file
  newNo?: number; // 1-based line number in the new file
}

// LCS over the changed middle section is O(n·m); above this many cells fall
// back to "delete old block, add new block" so huge files can't freeze the tab.
const MAX_LCS_CELLS = 4_000_000;

// Marks a final line that has no trailing newline, so "x" vs "x\n" counts as a
// real change in unified diffs (git needs the "\ No newline at end of file" marker).
const NO_EOL = '\u0000';

function splitLines(text: string, markEol: boolean): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing newline is not an extra line
  else if (markEol) lines[lines.length - 1] += NO_EOL;
  return lines;
}

export function diffLines(before: string, after: string, opts: { markEol?: boolean } = {}): DiffLine[] {
  const a = splitLines(before, !!opts.markEol);
  const b = splitLines(after, !!opts.markEol);

  // Trim the common prefix/suffix — CI fixes usually touch a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length, m = midB.length;

  if (n * m > MAX_LCS_CELLS) {
    midA.forEach((text, i) => out.push({ type: 'del', text, oldNo: start + i + 1 }));
    midB.forEach((text, j) => out.push({ type: 'add', text, newNo: start + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of midA[i:] and midB[j:]
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ type: 'same', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 }); i++; j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        // deletions first on ties — the conventional git ordering (- then +)
        out.push({ type: 'del', text: midA[i], oldNo: start + i + 1 }); i++;
      } else {
        out.push({ type: 'add', text: midB[j], newNo: start + j + 1 }); j++;
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ type: 'same', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** Group a diff into hunks with `context` unchanged lines around each change. */
export function diffHunks(lines: DiffLine[], context = 3): DiffLine[][] {
  const changed = lines.map((l, i) => (l.type === 'same' ? -1 : i)).filter(i => i >= 0);
  if (changed.length === 0) return [];
  const hunks: DiffLine[][] = [];
  let from = Math.max(0, changed[0] - context);
  let to = Math.min(lines.length - 1, changed[0] + context);
  for (const idx of changed.slice(1)) {
    if (idx - context <= to + 1) {
      to = Math.min(lines.length - 1, idx + context);
    } else {
      hunks.push(lines.slice(from, to + 1));
      from = Math.max(0, idx - context);
      to = Math.min(lines.length - 1, idx + context);
    }
  }
  hunks.push(lines.slice(from, to + 1));
  return hunks;
}

/** Standard unified diff (`git apply` compatible for text files). `before === null` means a new file. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const lines = diffLines(before ?? '', after, { markEol: true });
  const hunks = diffHunks(lines, context);
  if (hunks.length === 0) return '';

  const header = before === null
    ? [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`]
    : [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];

  const body = hunks.map(hunk => {
    const oldLines = hunk.filter(l => l.type !== 'add');
    const newLines = hunk.filter(l => l.type !== 'del');
    // Line numbers for an empty side follow the unified-diff convention (line before the hunk).
    const oldStart = oldLines[0]?.oldNo ?? Math.max(0, (hunk.find(l => l.newNo)?.newNo ?? 1) - 1);
    const newStart = newLines[0]?.newNo ?? Math.max(0, (hunk.find(l => l.oldNo)?.oldNo ?? 1) - 1);
    const range = (s: number, len: number) => (len === 1 ? `${s}` : `${s},${len}`);
    const rows = hunk.flatMap(l => {
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      return l.text.endsWith(NO_EOL)
        ? [sign + l.text.slice(0, -1), '\\ No newline at end of file']
        : [sign + l.text];
    });
    return [`@@ -${range(oldStart, oldLines.length)} +${range(newStart, newLines.length)} @@`, ...rows].join('\n');
  });

  return [...header, ...body].join('\n') + '\n';
}
