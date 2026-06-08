/**
 * agent/index.ts — public API for the Aegis healing agent
 *
 * Usage anywhere in the app:
 *
 *   import { runHealingAgent } from '@/app/lib/agent';
 *   import type { PipelineContext, HealingPlan } from '@/app/lib/agent';
 *
 *   const plan = await runHealingAgent(geminiKey, {
 *     pipelineId:   run.id,
 *     projectName:  'my-repo',
 *     branch:       'main',
 *     failedStage:  'test',
 *     errorMessage: 'npm ERR! code ENOENT',
 *     logs:         fullLogText,
 *   });
 *
 *   if (plan) {
 *     console.log(plan.severity);      // 'high'
 *     console.log(plan.fixSteps);      // ['Delete node_modules...', ...]
 *     console.log(plan.autoHealable);  // true / false
 *     console.log(plan.reasoning);     // each tool call + result
 *   }
 *
 * Files in this folder:
 *   types.ts  — TypeScript interfaces (PipelineContext, HealingPlan, etc.)
 *   tools.ts  — Tool schemas (sent to Gemini) + tool implementations
 *   loop.ts   — The agentic loop that calls Gemini with function calling
 *   index.ts  — This file: re-exports everything
 */

export { runHealingAgent } from './loop';
export type { PipelineContext, HealingPlan, ReasoningStep, Severity } from './types';
