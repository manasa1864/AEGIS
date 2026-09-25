// Structured, live state of one healing run — what the UI renders.
//
// The intelligence stream is a text log; this is the same run as data:
// which phase is active, what failed, which categories were diagnosed, every
// fix with its before/after content and commit status, the PR and CI verdict.
// All helpers are pure so the hook can apply them via setState(prev => ...).

export type PhaseId = 'detect' | 'analyze' | 'diagnose' | 'fix' | 'validate' | 'commit' | 'pr' | 'verify';
export type PhaseState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export const PHASES: Array<{ id: PhaseId; label: string; hint: string }> = [
  { id: 'detect',   label: 'DETECT',   hint: 'find failing pipelines' },
  { id: 'analyze',  label: 'ANALYZE',  hint: 'jobs, steps & logs' },
  { id: 'diagnose', label: 'DIAGNOSE', hint: 'classify root causes' },
  { id: 'fix',      label: 'FIX',      hint: 'rule engine → AI' },
  { id: 'validate', label: 'VALIDATE', hint: 'safety checks' },
  { id: 'commit',   label: 'COMMIT',   hint: 'fix branch' },
  { id: 'pr',       label: 'PR',       hint: 'open PR / MR' },
  { id: 'verify',   label: 'VERIFY',   hint: 'CI on fix branch' },
];

export type FixSource = 'rule' | 'ai' | 'static' | 'deep' | 'resume';
export type FixStatus = 'proposed' | 'blocked' | 'committing' | 'committed' | 'failed';

export interface TrackedFix {
  path: string;
  explanation: string;
  source: FixSource;
  status: FixStatus;
  before: string | null; // null = new file
  after: string;
  note?: string;         // block reason / commit error
}

export type OutcomeKind = 'healed' | 'clean' | 'halted' | 'safe_mode' | 'cancelled' | 'error';

export interface HealingRun {
  startedAt: number | null;
  phases: Record<PhaseId, PhaseState>;
  failure?: { workflows: string[]; jobs: string[]; steps: string[]; url?: string; sha?: string };
  categories: string[];
  engine?: 'rules' | 'ai' | 'static';
  confidence?: number;
  fixes: TrackedFix[];
  branch?: string;
  prUrl?: string;
  verify?: 'running' | 'success' | 'failure' | 'timeout';
  outcome?: { kind: OutcomeKind; reason: string };
}

const allPhases = (state: PhaseState): Record<PhaseId, PhaseState> =>
  Object.fromEntries(PHASES.map(p => [p.id, state])) as Record<PhaseId, PhaseState>;

export const emptyRun = (): HealingRun => ({ startedAt: null, phases: allPhases('pending'), categories: [], fixes: [] });

export const startRun = (): HealingRun => ({ ...emptyRun(), startedAt: Date.now(), phases: { ...allPhases('pending'), detect: 'active' } });

/** Set one phase. Starting a phase completes every earlier phase that is still active. */
export function withPhase(run: HealingRun, id: PhaseId, state: PhaseState): HealingRun {
  const phases = { ...run.phases, [id]: state };
  if (state === 'active') {
    for (const p of PHASES) {
      if (p.id === id) break;
      if (phases[p.id] === 'active') phases[p.id] = 'done';
      if (phases[p.id] === 'pending') phases[p.id] = 'skipped';
    }
  }
  return { ...run, phases };
}

/** Replace the fix list (after the engine has produced its candidates). */
export function withFixes(
  run: HealingRun,
  fixes: Array<{ path: string; content: string; explanation: string }>,
  originals: Array<{ path: string; content: string }>,
  source: FixSource,
): HealingRun {
  const byPath = new Map(originals.map(f => [f.path, f.content]));
  const tracked: TrackedFix[] = fixes
    .filter(f => typeof f.path === 'string' && typeof f.content === 'string')
    .map(f => ({
      path: f.path,
      explanation: f.explanation ?? '',
      source,
      status: 'proposed',
      before: byPath.get(f.path) ?? null,
      after: f.content,
    }));
  // Keep fixes from other sources (e.g. static analysis merged later) that touch other paths
  const kept = run.fixes.filter(f => !tracked.some(t => t.path === f.path));
  return { ...run, fixes: [...kept, ...tracked] };
}

export function withFixStatus(run: HealingRun, path: string, status: FixStatus, note?: string): HealingRun {
  return { ...run, fixes: run.fixes.map(f => (f.path === path ? { ...f, status, note: note ?? f.note } : f)) };
}

/** Append fixes from a later pass (deep diagnosis / resume) without replacing earlier ones. */
export function withExtraFixes(
  run: HealingRun,
  fixes: Array<{ path: string; content: string; explanation: string }>,
  originals: Array<{ path: string; content: string }>,
  source: FixSource,
): HealingRun {
  const byPath = new Map(originals.map(f => [f.path, f.content]));
  const extra: TrackedFix[] = fixes.map(f => ({
    path: f.path, explanation: f.explanation ?? '', source, status: 'proposed',
    before: byPath.get(f.path) ?? null, after: f.content,
  }));
  return { ...run, fixes: [...run.fixes.filter(f => !(f.source === source && extra.some(e => e.path === f.path))), ...extra] };
}

/** Finish the run: settle any still-active phase and record why it ended. */
export function withOutcome(run: HealingRun, kind: OutcomeKind, reason: string): HealingRun {
  const phases = { ...run.phases };
  const failedKinds: OutcomeKind[] = ['halted', 'error'];
  for (const p of PHASES) {
    if (phases[p.id] === 'active') phases[p.id] = failedKinds.includes(kind) ? 'failed' : kind === 'cancelled' ? 'skipped' : 'done';
    else if (phases[p.id] === 'pending') phases[p.id] = 'skipped';
  }
  return { ...run, phases, outcome: { kind, reason } };
}

/** Advance phases/statuses from an intelligence-stream message. The hook emits
 *  these messages at each step, so this keeps the structured run in lock-step
 *  with the stream without duplicating a state update at every call site. */
export function applyStreamMessage(run: HealingRun, message: string, url?: string): HealingRun {
  const has = (s: string) => message.includes(s);
  const pathOf = () => message.match(/path=(\S+)/)?.[1];

  if (has('fetching_workflow_runs') || has('fetching_pipelines')) return withPhase(run, 'detect', 'active');
  if (message.startsWith('ci_failure ::') || message.startsWith('pipeline_failure ::')) return withPhase(run, 'analyze', 'active');
  if (has('#2 :: strategy=ai_analysis')) return withPhase(run, 'diagnose', 'active');
  if (message.startsWith('ERROR_DIAGNOSED')) return withPhase(run, 'fix', 'active');
  if (has('strategy=create_branch')) {
    return withPhase({ ...run, branch: message.match(/name=(\S+)/)?.[1] ?? run.branch }, 'commit', 'active');
  }
  if (has('strategy=commit_fix')) { const p = pathOf(); return p ? withFixStatus(run, p, 'committing') : run; }
  if (message.startsWith('fix_committed')) { const p = pathOf(); return p ? withFixStatus(run, p, 'committed') : run; }
  if (message.startsWith('commit_failed')) { const p = pathOf(); return p ? withFixStatus(run, p, 'failed', 'commit rejected by the API') : run; }
  if (has('strategy=create_pull_request') || has('strategy=create_merge_request')) return withPhase(run, 'pr', 'active');
  if (message.startsWith('PR_CREATED') || message.startsWith('MR_CREATED')) return withPhase({ ...run, prUrl: url ?? run.prUrl }, 'pr', 'done');
  if (message.startsWith('pr_creation_failed') || message.startsWith('mr_creation_failed')) return withPhase(run, 'pr', 'failed');
  if (message.startsWith('VERIFY_FIX')) return withPhase({ ...run, verify: 'running' }, 'verify', 'active');
  if (message.startsWith('FIX_VERIFIED')) return withPhase({ ...run, verify: 'success' }, 'verify', 'done');
  if (message.startsWith('FIX_UNVERIFIED')) return { ...run, verify: 'failure' };
  if (message.startsWith('DEEP_UNVERIFIED')) return withPhase({ ...run, verify: 'failure' }, 'verify', 'failed');
  if ((message.startsWith('VERIFY_TIMEOUT') || message.startsWith('DEEP_VERIFY_TIMEOUT')) && /monitor/i.test(message)) {
    return withPhase({ ...run, verify: 'timeout' }, 'verify', 'done');
  }
  return run;
}

/** Classify how a run ended from its state and the last decision message. */
export function inferOutcome(run: HealingRun, lastDecision: string): { kind: OutcomeKind; reason: string } {
  const reason = lastDecision.replace(/^[A-Z_]+ :: /, '').replace(/_/g, ' ') || 'Run finished';
  if (/NO_FAILURES_DETECTED/.test(lastDecision)) return { kind: 'clean', reason: 'No failing pipelines — CI is already green' };
  if (/SAFE_MODE/.test(lastDecision)) return { kind: 'safe_mode', reason: `Safe mode: ${run.fixes.length} fix(es) proposed, nothing committed` };
  if (/HEALING_CANCELLED/.test(lastDecision)) return { kind: 'cancelled', reason: 'Operator rejected the low-confidence fix' };
  if (/^ERROR ::/.test(lastDecision)) return { kind: 'error', reason };
  if (run.prUrl) return { kind: 'healed', reason: run.verify === 'success' ? 'Fix PR opened and CI is green on the fix branch' : 'Fix PR opened' };
  return { kind: 'halted', reason };
}

/** Graph node status derived from the run (nodes stay lit after their phase finishes). */
export type NodeStatus = 'idle' | 'active' | 'error' | 'success' | 'processing';

export function nodeStatusFor(run: HealingRun, nodeId: string): NodeStatus {
  const p = run.phases;
  const from = (...ids: PhaseId[]): NodeStatus => {
    const states = ids.map(id => p[id]);
    if (states.includes('active')) return nodeId === 'fix-engine' ? 'processing' : 'active';
    if (states.includes('failed')) return 'error';
    if (states.includes('done')) return 'success';
    return 'idle';
  };
  switch (nodeId) {
    case 'code-push': return from('detect');
    case 'pipeline':
      // The pipeline is red from detection until the fix is verified green
      if (run.verify === 'success') return 'success';
      if (p.analyze === 'active') return 'active';
      return run.failure ? 'error' : from('detect');
    case 'error-detection': return from('analyze', 'diagnose');
    case 'fix-engine': return from('fix');
    case 'validation': return run.verify === 'failure' ? 'error' : from('validate', 'verify');
    case 'database':
      return run.fixes.some(f => f.status === 'committing') ? 'active' : from('commit');
    case 'core':
      if (run.outcome?.kind === 'healed' || run.outcome?.kind === 'clean') return 'success';
      if (run.outcome && ['halted', 'error'].includes(run.outcome.kind)) return 'error';
      return run.startedAt && !run.outcome ? 'active' : 'idle';
    default: return 'idle';
  }
}

/** Data is flowing along from → to while the run is live and the edge feeds a working node. */
export function edgeActive(run: HealingRun, from: string, to: string): boolean {
  if (run.outcome || !run.startedAt) return false;
  const live = (id: string) => ['active', 'processing'].includes(nodeStatusFor(run, id));
  return to === 'core' ? live(from) : live(to);
}
