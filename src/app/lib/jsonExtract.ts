// Robust JSON extraction from LLM responses — shared by every AI provider
// (Groq, Gemini, Vertex AI) so they all parse identically.
//
// Models frequently wrap JSON in ```json fences, prepend commentary, or append
// trailing prose. The old per-provider approaches had two failure modes:
//   • greedy regex /\{[\s\S]*\}/ grabs from the FIRST { to the LAST } — any
//     stray brace in trailing prose breaks the parse;
//   • naive depth counting breaks when fix content contains unbalanced braces
//     inside JSON string literals (extremely common: shell scripts, GitHub
//     Actions `${{ }}` expressions, Jinja templates).
//
// extractJson does a string-literal-aware balanced scan: braces inside quoted
// strings (with escape handling) are ignored, so the first syntactically
// complete top-level object is returned.

/** Extract and parse the first complete top-level JSON object found in `text`.
 *  Returns null if nothing parseable is found. */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;

  // Strategy 1 — whole text after stripping markdown fences.
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch { /* fall through */ }

  // Strategy 2 — string-aware balanced-brace scan.
  // Try every '{' as a candidate start (first match wins) so leading prose
  // containing a stray '{' can't poison the scan.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const start = text.indexOf('{', searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            break; // not valid JSON from this start — try the next '{'
          }
        }
      }
    }
    searchFrom = start + 1;
  }
  return null;
}
