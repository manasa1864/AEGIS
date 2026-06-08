// ── Agent types ───────────────────────────────────────────────────────────────
// All TypeScript interfaces used by the healing agent.

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Input: everything the agent needs to know about a failed pipeline. */
export interface PipelineContext {
  pipelineId: string | number;
  projectName: string;
  branch: string;
  failedStage: string;
  errorMessage: string;
  logs: string;
}

/** One step in the agent's reasoning — which tool it called and what it got back. */
export interface ReasoningStep {
  tool: string;
  result: string;
}

/** Output: the full healing plan produced by the agent. */
export interface HealingPlan {
  rootCause: string;
  severity: Severity;
  fixSteps: string[];
  autoHealable: boolean;
  estimatedTime: string;
  reasoning: ReasoningStep[];
}
