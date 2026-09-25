import { geminiGenerateUrl } from './models';
export interface HealingPlan {
  rootCause: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  autoHealable: boolean;
  estimatedTime: string;
}

interface AgentInput {
  pipelineId: string | number;
  projectName: string;
  branch: string;
  failedStage: string;
  errorMessage: string;
  logs: string;
}

export async function runHealingAgent(geminiKey: string, input: AgentInput): Promise<HealingPlan | null> {
  if (!geminiKey) return null;

  const prompt = `You are a CI/CD diagnosis agent. Analyze this pipeline failure and respond with JSON only (no markdown wrapper):

Project: ${input.projectName} (branch: ${input.branch})
Failed stage: ${input.failedStage}
Error: ${input.errorMessage}
Logs:
${input.logs}

{
  "rootCause": "one concise sentence describing the root cause",
  "severity": "low|medium|high|critical",
  "autoHealable": true,
  "estimatedTime": "e.g. 2 minutes"
}

Rules:
- severity: "critical" if blocking deploy, "high" if blocking CI, "medium" if flaky, "low" if minor
- autoHealable: true only if a config/dependency fix can resolve it without code logic changes
- estimatedTime: realistic estimate to apply and verify the fix`;

  try {
    const res = await fetch(geminiGenerateUrl(), {
      method: 'POST',
      headers: { 'x-goog-api-key': geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<HealingPlan>;
    return {
      rootCause: parsed.rootCause ?? 'unknown',
      severity: parsed.severity ?? 'high',
      autoHealable: parsed.autoHealable ?? false,
      estimatedTime: parsed.estimatedTime ?? 'unknown',
    };
  } catch {
    return null;
  }
}
