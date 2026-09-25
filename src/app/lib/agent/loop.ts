/**
 * agent/loop.ts
 *
 * The agentic loop — sends a pipeline failure to Gemini with function-calling
 * enabled, then runs in a loop:
 *   1. Gemini decides which tool to call next
 *   2. We execute the tool locally (tools.ts)
 *   3. We send the result back to Gemini
 *   4. Repeat until Gemini has enough information to write the final HealingPlan
 *
 * This is the same core architecture as Google Cloud Agent Builder — the model
 * orchestrates tools rather than generating one monolithic response.
 *
 * To swap in Google Cloud Agent Builder later, see: agentBuilder.ts (when ready).
 */

import {
  TOOL_DECLARATIONS,
  analyzePipelineFailure,
  classifySeverity,
  suggestFix,
  decideAutoHeal,
} from './tools';
import type { PipelineContext, HealingPlan, ReasoningStep } from './types';
import { extractJson } from '../jsonExtract';
import { geminiGenerateUrl } from '../models';

const GEMINI_URL = geminiGenerateUrl();
const MAX_TURNS = 10; // safety limit to prevent runaway loops

const SYSTEM_PROMPT = `You are Aegis, an AI Site Reliability Engineer specialized in CI/CD pipeline healing.

When given a pipeline failure, call the tools in this order:
1. analyze_pipeline_failure — identify what went wrong
2. classify_severity        — determine how critical it is
3. suggest_fix              — generate concrete fix steps
4. decide_auto_heal         — decide if automated healing is safe

After all tool calls, respond ONLY with this JSON (no markdown, no explanation):
{
  "rootCause": "string",
  "severity": "critical|high|medium|low",
  "fixSteps": ["step1", "step2", "..."],
  "autoHealable": true|false,
  "estimatedTime": "string"
}`;

// Gemini message part types
type TextPart             = { text: string };
type FunctionCallPart     = { functionCall: { name: string; args: Record<string, unknown> } };
type FunctionResponsePart = { functionResponse: { name: string; response: Record<string, unknown> } };
type GeminiPart           = TextPart | FunctionCallPart | FunctionResponsePart;
type GeminiMessage        = { role: string; parts: GeminiPart[] };

/** Dispatch a Gemini tool call to the correct local implementation. */
function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'analyze_pipeline_failure':
      return analyzePipelineFailure(args as Parameters<typeof analyzePipelineFailure>[0]);
    case 'classify_severity':
      return classifySeverity(args as Parameters<typeof classifySeverity>[0]);
    case 'suggest_fix':
      return suggestFix(args as Parameters<typeof suggestFix>[0]);
    case 'decide_auto_heal':
      return decideAutoHeal(args as Parameters<typeof decideAutoHeal>[0]);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Run the full healing agent for a failed pipeline.
 * Returns a HealingPlan, or null if the API call fails or the key is missing.
 */
export async function runHealingAgent(
  geminiKey: string,
  context: PipelineContext,
): Promise<HealingPlan | null> {
  if (!geminiKey) return null;

  const reasoning: ReasoningStep[] = [];

  const userPrompt = `Pipeline failure detected — please analyze and produce a healing plan.

Project:      ${context.projectName}
Branch:       ${context.branch}
Failed stage: ${context.failedStage}
Error:        ${context.errorMessage}
Logs (last 800 chars):
${context.logs.slice(-800)}`;

  // Conversation history — grows as tools are called and results come back
  const history: GeminiMessage[] = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n' + userPrompt }] },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: history,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const parts: GeminiPart[] = data.candidates?.[0]?.content?.parts ?? [];
    if (!parts.length) return null;

    // Add the model's response to history
    history.push({ role: 'model', parts });

    // Separate function calls from text parts
    const fnCalls = parts.filter(
      (p): p is FunctionCallPart => 'functionCall' in p,
    );

    if (fnCalls.length === 0) {
      // No more tool calls — Gemini is done, parse the final JSON answer
      const textPart = parts.find((p): p is TextPart => 'text' in p);
      if (!textPart) return null;

      {
        const parsed = extractJson<Record<string, never>>(textPart.text) as Record<string, unknown> | null;
        if (!parsed) return null;
        return {
          rootCause:    parsed.rootCause    ?? 'Unknown',
          severity:     parsed.severity     ?? 'medium',
          fixSteps:     parsed.fixSteps     ?? [],
          autoHealable: parsed.autoHealable ?? false,
          estimatedTime: parsed.estimatedTime ?? 'Unknown',
          reasoning,
        } as HealingPlan;
      }
    }

    // Execute each tool Gemini requested and collect the responses
    const toolResponses: GeminiPart[] = [];
    for (const fc of fnCalls) {
      const result = callTool(fc.functionCall.name, fc.functionCall.args);
      reasoning.push({
        tool: fc.functionCall.name,
        result: JSON.stringify(result, null, 2),
      });
      toolResponses.push({
        functionResponse: {
          name: fc.functionCall.name,
          response: result,
        },
      });
    }

    // Send tool results back as a user turn so Gemini can continue
    history.push({ role: 'user', parts: toolResponses });
  }

  return null; // hit MAX_TURNS without a final answer
}
