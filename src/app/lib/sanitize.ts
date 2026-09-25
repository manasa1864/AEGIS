// Guards applied to ALL repository content before it reaches any AI model.
//
// Two responsibilities:
//   1. sanitizeForAI  — strip prompt-injection patterns from untrusted text
//      (logs, README, workflow files, scripts) so a malicious repo cannot
//      hijack the model with embedded instructions.
//   2. chunkLogs      — extract only the error-relevant portion of large logs
//      so we stay within model token limits and keep quality high.

// ── 1. Prompt-injection sanitisation ─────────────────────────────────────────

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:(?:all|any|the)\s+)?(?:previous|prior|above|earlier|preceding|system)\s+instructions?/gi,
  /forget\s+(everything|all\s+previous|prior)/gi,
  /you\s+are\s+now\s+(a|an)\s+/gi,
  /act\s+as\s+(a|an)\s+(unrestricted|evil|unfiltered|jailbroken)/gi,
  /\bsystem\s*:\s*you\s+are\b/gi,
  /\[SYSTEM\]/gi,
  /\[INST\]/gi,
  /\[\/INST\]/gi,
  /<<SYS>>/gi,
  /<\|im_start\|>/gi,
  /jailbreak/gi,
  /do\s+anything\s+now/gi,
  /\bdan\s+mode\b/gi,
  /rm\s+-rf\s+\//gi,
  /del\s+\/f\s+\/s\s+\/q/gi,
  /delete\s+all\s+files/gi,
  /format\s+(c:|the\s+disk)/gi,
  /exfiltrate/gi,
];

export function sanitizeForAI(text: string): string {
  let safe = text;
  for (const pattern of INJECTION_PATTERNS) {
    safe = safe.replace(pattern, '[FILTERED]');
  }
  return safe;
}

// ── 2. Log chunking ───────────────────────────────────────────────────────────

// Character budget before chunking kicks in (~1 500 tokens at ~4 chars/token).
const MAX_LOG_CHARS = 6_000;

// Lines matching this are treated as "high-value" and kept with context.
const ERROR_LINE_RE =
  /\b(error|fail(ed|ure)?|fatal|exception|traceback|stderr|abort|panic|critical|killed|oom|segfault|coredump)\b/i;

/**
 * Sanitize + extract the most relevant portion of CI log output.
 *
 * Strategy (in order):
 *   1. Sanitize injection patterns.
 *   2. If within budget, return as-is.
 *   3. Extract error lines ± 5 lines of surrounding context.
 *   4. If the extracted chunk still exceeds budget, fall back to the tail
 *      (most recent output is almost always where the failure is).
 */
export function chunkLogs(rawLogs: string): string {
  const sanitized = sanitizeForAI(rawLogs);
  if (sanitized.length <= MAX_LOG_CHARS) return sanitized;

  const lines = sanitized.split('\n');
  const keepIdx = new Set<number>();

  lines.forEach((line, i) => {
    if (ERROR_LINE_RE.test(line)) {
      const start = Math.max(0, i - 3);
      const end   = Math.min(lines.length - 1, i + 5);
      for (let j = start; j <= end; j++) keepIdx.add(j);
    }
  });

  if (keepIdx.size > 0) {
    const chunk = [...keepIdx]
      .sort((a, b) => a - b)
      .map(i => lines[i])
      .join('\n');

    if (chunk.length <= MAX_LOG_CHARS) return chunk;
  }

  // Tail fallback — last N characters
  const tail = sanitized.slice(-MAX_LOG_CHARS);
  return `[logs: ${lines.length} lines total — truncated to last section]\n${tail}`;
}
