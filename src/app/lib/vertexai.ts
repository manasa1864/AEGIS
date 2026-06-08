import type { AnalysisResult } from './gemini';

// Google Cloud Agent Builder / Vertex AI Gemini with Google Search Grounding
//
// APIs used (VITE_GCLOUD_KEY):
//   • Vertex AI Gemini (gemini-2.0-flash) — generativelanguage.googleapis.com
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
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
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
    res = await fetch('/api/gcloud/v1beta/models/gemini-2.0-flash:generateContent', {
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
          maxOutputTokens: 2048,
        },
      }),
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  // Extract grounding source URLs if present
  const sources: GroundingSource[] = (
    data.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
  ).flatMap((chunk: { web?: { uri?: string; title?: string } }) =>
    chunk.web?.uri ? [{ url: chunk.web.uri, title: chunk.web.title ?? chunk.web.uri }] : []
  );

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<AnalysisResult>;
    return {
      analysis: parsed.analysis ?? '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 75,
      fixes: parsed.fixes ?? [],
      ranked_alternatives: parsed.ranked_alternatives ?? [],
      sources,
    };
  } catch {
    return null;
  }
}
