import type { AnalysisResult } from './gemini';
import { extractJson } from './jsonExtract';
import { geminiGenerateUrl, geminiText } from './models';
import { sanitizeForAI } from './sanitize';

// Google Cloud Agent Builder / Vertex AI Gemini with Google Search Grounding
//
// APIs used (VITE_GCLOUD_KEY):
//   • Gemini (see GEMINI_MODEL in models.ts) — generativelanguage.googleapis.com
//   • Google Search Grounding tool — lets the model look up real CI/CD docs,
//     Stack Overflow answers, and known issues before generating fixes
//   • Grounding metadata — response includes source URLs used during reasoning
//
// Why grounding beats plain Gemini for CI/CD:
//   The model can search for the exact error message, find the GitHub issue or
//   official docs that explain the fix, and cite it in the analysis — rather
//   than reasoning only from the workflow file text.

export interface GroundingSource {
  title: string;
  url: string;
}

export interface GroundedAnalysisResult extends AnalysisResult {
  sources?: GroundingSource[];
}

export async function analyzeWithGrounding(
  gcloudKey: string,
  errorContext: string,
  files: Array<{ path: string; content: string }>
): Promise<GroundedAnalysisResult | null> {
  const filesText = files
    .map(f => `### ${f.path}\n\`\`\`\n${sanitizeForAI(f.content)}\n\`\`\``)
    .join('\n\n');

  const prompt = `You are an AI agent that analyzes CI/CD pipeline failures.
Use Google Search to find known solutions, official docs, and GitHub issues related to the error before generating your fix.

CI/CD Failure Context:
${errorContext}

Repository Files:
${filesText}

Analyze the failure and respond with JSON only (no markdown wrapper):
{
  "analysis": "one sentence explaining the root cause, citing any sources found",
  "confidence": 85,
  "fixes": [
    {
      "path": "exact/path/to/file",
      "content": "complete corrected file content",
      "explanation": "one sentence describing the change"
    }
  ],
  "ranked_alternatives": [
    {
      "description": "alternative fix strategy",
      "confidence": 65,
      "risk": "low"
    }
  ]
}

Rules:
- confidence: integer 0–100
- Only include files that need changes
- Provide complete file content (not diffs)
- Keep fixes minimal and targeted
- risk values: "low" | "medium" | "high"
- If you cannot determine a fix, return empty fixes[] and confidence below 50`;

  let res: Response;
  try {
    res = await fetch(geminiGenerateUrl('/api/gcloud'), {
      method: 'POST',
      headers: {
        'x-goog-api-key': gcloudKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          // Fixes carry COMPLETE file contents (and thinking tokens count toward
          // this budget on current Flash models) — 2048 truncated the JSON.
          maxOutputTokens: 8192,
        },
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  // A misrouted proxy (e.g. SPA fallback returning index.html) must not throw
  // and abort the whole healing run — just fall through to the next provider.
  const data = await res.json().catch(() => null);
  if (!data) return null;
  const text = geminiText(data);

  // Extract grounding source URLs if present
  const sources: GroundingSource[] = (
    data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
  ).flatMap((chunk: { web?: { uri?: string; title?: string } }) =>
    chunk.web?.uri ? [{ url: chunk.web.uri, title: chunk.web.title ?? chunk.web.uri }] : []
  );

  const parsed = extractJson<Partial<AnalysisResult>>(text);
  if (!parsed) return null;
  return {
    analysis: parsed.analysis ?? '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 75,
    fixes: parsed.fixes ?? [],
    ranked_alternatives: parsed.ranked_alternatives ?? [],
    sources,
  };
}
