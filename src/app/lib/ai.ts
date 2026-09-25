import { extractJson } from './jsonExtract';
import { GEMINI_EMBEDDING_MODEL, GROQ_MODEL, geminiGenerateUrl, geminiText } from './models';

/**
 * AI utilities — call priority:
 *   1. Gemini API (Google AI — free tier via API key from aistudio.google.com)
 *   2. Groq (fast open-source LLM, fallback)
 *
 * Embeddings: Gemini embedding model (see models.ts)
 */

export async function callAI(geminiKey: string, groqKey: string, prompt: string): Promise<string> {
  // 1. Gemini (Google AI)
  if (geminiKey) {
    try {
      const res = await fetch(geminiGenerateUrl(), {
        method: 'POST',
        headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      if (res.ok) {
        const text = geminiText(await res.json());
        if (text) return text;
      }
    } catch { /* fall through */ }
  }

  // 2. Groq fallback
  if (groqKey) {
    try {
      const res = await fetch('/api/groq/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        const text = d.choices?.[0]?.message?.content ?? '';
        if (text) return text;
      }
    } catch { /* fall through */ }
  }

  return '';
}

export async function getEmbedding(geminiKey: string, text: string): Promise<number[]> {
  if (!geminiKey) return [];
  try {
    const res = await fetch(`/api/gemini/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { parts: [{ text }] } }),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return d.embedding?.values ?? [];
  } catch {
    return [];
  }
}

export function parseJSON<T>(text: string): T | null {
  return extractJson<T>(text);
}
