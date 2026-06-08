import type { HealingEventRecord } from '../types';
import type { ErrorDiagnosis } from './diagnostics';

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
}

export async function analyzeAndFixWithGroq(
  apiKey: string,
  errorContext: string,
  files: Array<{ path: string; content: string }>,
  diagnosis?: ErrorDiagnosis | ErrorDiagnosis[],
): Promise<AnalysisResult | null> {
  // Truncate each file to 3000 chars and cap total at 12000 to stay under Groq's HTTP body limit.
  const MAX_FILE = 3000;
  const MAX_TOTAL = 12000;
  let totalChars = 0;
  const filesText = files
    .map(f => {
      const content = f.content.length > MAX_FILE ? f.content.slice(0, MAX_FILE) + '\n…[truncated]' : f.content;
      return `### ${f.path}\n\`\`\`\n${content}\n\`\`\``;
    })
    .filter(block => {
      totalChars += block.length;
      return totalChars <= MAX_TOTAL;
    })
    .join('\n\n');

  // Build a category block for EVERY matched diagnosis, ranked by confidence.
  // Giving the AI all root causes prevents it from tunnel-visioning on one fix.
  const diagArray = diagnosis
    ? (Array.isArray(diagnosis) ? diagnosis : [diagnosis])
    : [];

  const categoryBlock = diagArray.length > 0
    ? diagArray.map((d, i) =>
        `${i === 0 ? '⚠ PRIMARY' : `◦ SECONDARY #${i}`} ERROR CATEGORY: ${d.category}\n` +
        `Description: ${d.description}\n` +
        `Fix Strategy:\n${d.instructions}`
      ).join('\n\n') + '\n\n'
    : '';

  const prompt = `You are an expert CI/CD forensics AI. Your job is to perform a COMPLETE, EXHAUSTIVE analysis of this pipeline failure and generate fixes that cover EVERY identified root cause — primary, secondary, and latent.

━━━ DETECTED ERROR CATEGORIES ━━━
${categoryBlock}━━━ CI/CD FAILURE CONTEXT ━━━
${errorContext}

━━━ REPOSITORY FILES (complete current state — use these EXACT paths) ━━━
${filesText}

━━━ ANALYSIS REQUIREMENTS ━━━
Think through ALL of the following dimensions before writing your response:

1. PRIMARY CAUSE — what is the single most likely root cause? Cite the exact log line or config value.
2. SECONDARY CAUSES — what other issues exist that would keep CI failing even after fixing the primary?
3. LATENT ISSUES — what problems exist in the repo config that are not causing THIS failure but will cause the next one?
4. PERMUTATION COVERAGE — if the error could stem from cause A OR cause B, provide fixes for BOTH A AND B.
5. MISSING FILES — are any files referenced but absent? (Dockerfile, .nvmrc, requirements.txt, jest.config, .env.example, etc.) Create them.
6. VERSION COMPATIBILITY — are dependency versions, Node.js versions, or action versions incompatible?
7. ENVIRONMENT GAPS — what would happen on a fresh runner with no cache, no secrets configured? Does the workflow handle that gracefully?
8. RUNNER ASSUMPTIONS — does the workflow assume Linux commands on a Windows runner, or vice versa?
9. SECRET / ENV RESILIENCE — do steps fail hard when optional secrets are absent? Add continue-on-error or fallbacks.
10. IDEMPOTENCY — will applying these fixes leave CI in a permanently healthy state, or will the same error recur?

━━━ RESPONSE FORMAT (JSON only — no markdown, no code fences around the JSON) ━━━
{
  "analysis": "Multi-paragraph forensic report covering ALL root causes found, their interactions, and exactly what in the repo config produced this failure. Minimum 3 sentences.",
  "primary_cause": "One sentence: the single most likely root cause with the exact evidence.",
  "secondary_causes": [
    "Second root cause that would keep CI failing even after primary is fixed",
    "Third root cause / latent issue to address proactively"
  ],
  "confidence": 85,
  "fixes": [
    {
      "path": "exact/path/to/file",
      "content": "COMPLETE corrected file content — every line, not a diff or snippet",
      "explanation": "What changed, which root cause it addresses, and why this resolves it",
      "addresses": "primary | secondary | latent",
      "risk": "low | medium | high"
    }
  ],
  "ranked_alternatives": [
    {
      "description": "Alternative strategy if the primary fixes do not resolve the issue — be specific",
      "confidence": 65,
      "risk": "low"
    }
  ]
}

━━━ HARD RULES ━━━
• Use EXACT file paths from "Repository Files" above
• You MAY (and SHOULD) create NEW files if they are missing and needed — e.g. .nvmrc, Dockerfile, jest.config.js, .env.example, requirements.txt, .prettierrc
• "content" must be the COMPLETE file — every line — never a diff or partial snippet
• confidence: integer 0–100 covering the FULL set of fixes as a whole
• fixes[] must include EVERY file that needs changing — leaving any broken file out means CI stays broken
• ranked_alternatives: up to 5 entries; always include "add continue-on-error to non-critical external-dependency steps" when secrets or third-party services are involved
• If multiple error categories were detected, your fixes MUST address ALL of them

━━━ WHEN NO ERROR LOGS ARE AVAILABLE (Failed jobs: none / Failed steps: none) ━━━
The workflow is failing BEFORE any jobs start — this always means a structural problem in the YAML itself.
Perform STATIC ANALYSIS on every provided YAML file. You MUST still produce fixes. Look for:
1. Tab indentation (YAML forbids tabs — replace with spaces)
2. Invalid GitHub Actions expression syntax — e.g. unclosed ${{ }}, wrong variable paths, using . where needs to be github.event.X
3. workflow_call triggers with invalid secrets: inherit — only valid when called by another workflow
4. on: push / pull_request missing the branches or paths filter when required
5. Deprecated action versions — e.g. actions/checkout@v2, actions/setup-node@v2 (upgrade to @v4)
6. jobs that reference steps or outputs that don't exist
7. needs: referencing a job name that doesn't exist in the same file
8. Invalid YAML keys or values — e.g. using a string where a map is expected
9. Missing required top-level keys: on, jobs
10. environment: or concurrency: blocks with incorrect structure
Always produce at least one fix for the failing workflow file(s). Never return empty fixes[] when YAML files are provided.`;

  const res = await fetch('/api/groq/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 8000,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text: string = data.choices?.[0]?.message?.content ?? '';

  try {
    // Strategy 1: try the whole text after stripping ```json fences
    // Strategy 2: balanced-bracket extraction (safe against greedy regex misfires)
    let rawJson: string | null = null;
    const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
    try { JSON.parse(stripped); rawJson = stripped; } catch { /* fall through */ }
    if (!rawJson) {
      const start = text.indexOf('{');
      if (start !== -1) {
        let depth = 0, i = start;
        for (; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (depth === 0) break; }
        }
        rawJson = text.slice(start, i + 1);
      }
    }
    if (!rawJson) return null;
    const parsed = JSON.parse(rawJson) as Partial<AnalysisResult> & {
      primary_cause?: string;
      secondary_causes?: string[];
    };

    // Merge primary_cause + secondary_causes into the analysis field if AI used the extended schema
    let analysis = parsed.analysis ?? '';
    if (parsed.primary_cause && !analysis.includes(parsed.primary_cause)) {
      const secondary = (parsed.secondary_causes ?? []).join(' | ');
      analysis = `${parsed.primary_cause}${secondary ? ` — Secondary: ${secondary}` : ''}. ${analysis}`.trim();
    }

    return {
      analysis,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 75,
      fixes: parsed.fixes ?? [],
      ranked_alternatives: parsed.ranked_alternatives ?? [],
    };
  } catch {
    return null;
  }
}

export async function generatePostmortem(
  apiKey: string,
  event: HealingEventRecord,
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

  const res = await fetch('/api/groq/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const msg = res.status === 429 ? 'Groq rate limit — wait a moment and try again'
      : res.status === 401 ? 'Groq API key rejected (401 Unauthorized)'
      : res.status === 404 ? 'Groq model not found'
      : `Groq request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
