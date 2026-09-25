// Single source of truth for AI model IDs — change a model here, not in each caller.
//
// Gemini: `gemini-flash-latest` is Google's rolling alias for the current Flash
// model. Pinned IDs get shut down (gemini-2.0-flash was retired June 2026 and
// text-embedding-004 in January 2026), which silently broke every Gemini call.

export const GEMINI_MODEL = 'gemini-flash-latest';
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
export const GROQ_MODEL = 'llama-3.3-70b-versatile';

/** Proxy path for a Gemini generateContent call (`/api/gemini` or `/api/gcloud`). */
export function geminiGenerateUrl(proxyBase: '/api/gemini' | '/api/gcloud' = '/api/gemini'): string {
  return `${proxyBase}/v1beta/models/${GEMINI_MODEL}:generateContent`;
}

/** Concatenate every text part of the first candidate. Grounded and longer
 *  responses are often split across several parts — reading only parts[0]
 *  truncates the JSON. Thought-summary parts are skipped. */
export function geminiText(data: unknown): string {
  const parts = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> })
    ?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}
