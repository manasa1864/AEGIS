import type { HealingEventRecord } from '../types';
import type { ErrorDiagnosis } from './diagnostics';
import { extractJson } from './jsonExtract';
import { sanitizeForAI } from './sanitize';
import { geminiGenerateUrl, geminiText } from './models';

export interface Fix {
  path: string;
  content: string;
  explanation: string;
}

export interface RankedAlternative {
  description: string;
  confidence: number;
  risk: 'low' | 'medium' | 'high';
}

export interface AnalysisResult {
  analysis: string;
  confidence: number;
  fixes: Fix[];
  ranked_alternatives: RankedAlternative[];
  /** Files the model returned but had only seen partially — refused, never applied. */
  refusedPartial?: string[];
}

export async function analyzeAndFixWithGemini(
  apiKey: string,
  errorContext: string,
  files: Array<{ path: string; content: string }>,
  diagnosis?: ErrorDiagnosis,
): Promise<AnalysisResult | null> {
  const filesText = files
    .map(f => `### ${f.path}\n\`\`\`\n${sanitizeForAI(f.content)}\n\`\`\``)
    .join('\n\n');

  const categoryBlock = diagnosis
    ? `Error Category: ${diagnosis.category} — ${diagnosis.description}\n\nFix Strategy:\n${diagnosis.instructions}\n\n`
    : '';

  const prompt = `You are an AI agent that analyzes CI/CD pipeline failures and generates precise, targeted fixes.

${categoryBlock}CI/CD Failure Context:
${errorContext}

Repository Files (real files from the repo — use exact paths shown):
${filesText}

Respond with JSON only (no markdown wrapper):
{
  "analysis": "one sentence explaining the root cause",
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
      "description": "alternative fix strategy description",
      "confidence": 65,
      "risk": "low"
    },
    {
      "description": "second alternative fix strategy",
      "confidence": 40,
      "risk": "medium"
    }
  ]
}

Rules:
- Use exact paths from "Repository Files" above; you may also suggest NEW files (e.g. .nvmrc, requirements.txt)
- confidence: integer 0–100 — how certain this fix resolves the error
- Provide COMPLETE file content, not diffs
- Only include files that genuinely need changes
- ranked_alternatives: up to 3 strategies considered but not applied (risk: "low"|"medium"|"high")
- If you cannot determine a fix, return empty fixes[] and confidence below 40`;

  const request = () => fetch(geminiGenerateUrl(), {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  }).catch(() => null); // network failure → let the caller fall back

  let res = await request();
  if (res?.status === 429) {
    // Rate limited — wait 15s and retry once before giving up
    await new Promise(r => setTimeout(r, 15000));
    res = await request();
  }
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null);
  const parsed = extractJson<Partial<AnalysisResult>>(geminiText(data));
  if (!parsed) return null;
  return {
    analysis: parsed.analysis ?? '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 75,
    fixes: parsed.fixes ?? [],
    ranked_alternatives: parsed.ranked_alternatives ?? [],
  };
}

export async function generatePostmortem(
  apiKey: string,
  event: HealingEventRecord
): Promise<string> {
  const recoveryDisplay = event.recovery_time_ms
    ? `${Math.round(event.recovery_time_ms / 1000)}s (${Math.round(event.recovery_time_ms / 60000)}m)`
    : 'N/A';

  const prompt = `Generate a concise, professional incident postmortem report for the following CI/CD healing event.

Event Details:
- Project: ${event.project_name} (branch: ${event.branch})
- Provider: ${event.provider}
- Failed Stage: ${event.failed_stage ?? 'unknown'}
- Root Cause: ${event.root_cause ?? 'unknown'}
- Status: ${event.status}
- AI Confidence: ${event.confidence != null ? event.confidence + '%' : 'N/A'}
- Recovery Time: ${recoveryDisplay}
- Fix Steps Applied: ${(event.fix_steps ?? []).join('; ') || 'none'}
- Timestamp: ${event.created_at}

Write a professional postmortem in markdown format with these sections:
## Executive Summary
## Timeline
## Root Cause Analysis
## Impact Assessment
## Fix Applied
## Lessons Learned
## Prevention Measures

Be technical, concise, and actionable. Each section should be 2–4 sentences.`;

  const res = await fetch(geminiGenerateUrl(), {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const msg = res.status === 429 ? 'Gemini rate limit — wait a moment and try again'
      : res.status === 403 ? 'Gemini API key rejected (403 Forbidden)'
      : res.status === 404 ? 'Gemini model not found — model may have been deprecated'
      : `Gemini request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return geminiText(await res.json());
}
