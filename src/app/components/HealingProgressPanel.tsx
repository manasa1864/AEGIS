import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle, XCircle, Loader2, Circle, MinusCircle, ChevronDown, ChevronRight,
  ExternalLink, GitBranch, GitPullRequest, ShieldAlert, FileCode2,
} from 'lucide-react';
import { PHASES, type HealingRun, type PhaseState, type TrackedFix } from '../lib/healingRun';
import { DiffView } from './DiffView';

const C = {
  copper: '#CAAA98', muted: '#9A8678', green: '#6A9A7A', red: '#A06A6A', amber: '#D4A574',
};

const phaseColor: Record<PhaseState, string> = {
  pending: C.muted, active: C.amber, done: C.green, failed: C.red, skipped: C.muted,
};

function PhaseIcon({ state }: { state: PhaseState }) {
  const props = { className: 'w-3.5 h-3.5', strokeWidth: 1.75, style: { color: phaseColor[state] } };
  if (state === 'active') return <Loader2 {...props} className="w-3.5 h-3.5 animate-spin" />;
  if (state === 'done') return <CheckCircle {...props} />;
  if (state === 'failed') return <XCircle {...props} />;
  if (state === 'skipped') return <MinusCircle {...props} style={{ color: C.muted, opacity: 0.35 }} />;
  return <Circle {...props} style={{ color: C.muted, opacity: 0.35 }} />;
}

const FIX_STATUS: Record<TrackedFix['status'], { label: string; color: string }> = {
  proposed:   { label: 'PROPOSED',   color: C.copper },
  blocked:    { label: 'BLOCKED',    color: C.red },
  committing: { label: 'COMMITTING', color: C.amber },
  committed:  { label: 'COMMITTED',  color: C.green },
  failed:     { label: 'FAILED',     color: C.red },
};

const SOURCE_LABEL: Record<TrackedFix['source'], string> = {
  rule: 'RULE', ai: 'AI', static: 'STATIC', deep: 'DEEP_PASS', resume: 'RESUME',
};

const OUTCOME: Record<NonNullable<HealingRun['outcome']>['kind'], { label: string; color: string }> = {
  healed:    { label: 'HEALED',        color: C.green },
  clean:     { label: 'CI_ALREADY_GREEN', color: C.green },
  halted:    { label: 'HALTED',        color: C.red },
  safe_mode: { label: 'SAFE_MODE',     color: C.amber },
  cancelled: { label: 'CANCELLED',     color: C.muted },
  error:     { label: 'ERROR',         color: C.red },
};

function Elapsed({ since, frozen }: { since: number; frozen: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (frozen) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [frozen]);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

function FixRow({ fix, defaultOpen }: { fix: TrackedFix; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const st = FIX_STATUS[fix.status];
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="border border-[#CAAA98]/10 bg-[#0a0e1a]/50">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-[#CAAA98]/5 transition-colors">
        {open ? <ChevronDown className="w-3 h-3 mt-0.5 text-[#9A8678] flex-shrink-0" /> : <ChevronRight className="w-3 h-3 mt-0.5 text-[#9A8678] flex-shrink-0" />}
        <FileCode2 className="w-3 h-3 mt-0.5 text-[#9A8678]/60 flex-shrink-0" strokeWidth={1.5} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-[10px] text-[#CAAA98] break-all">{fix.path}</span>
            <span className="font-mono text-[8px] px-1.5 py-px border border-[#9A8678]/30 text-[#9A8678] tracking-wider">{SOURCE_LABEL[fix.source]}</span>
            <motion.span
              key={fix.status}
              initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className="font-mono text-[8px] px-1.5 py-px border tracking-wider flex items-center gap-1"
              style={{ color: st.color, borderColor: st.color + '60' }}
            >
              {fix.status === 'committing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              {st.label}
            </motion.span>
          </div>
          <div className="font-mono text-[9px] text-[#9A8678]/80 mt-1 leading-relaxed line-clamp-2">{fix.explanation}</div>
          {fix.note && fix.status !== 'committed' && (
            <div className="font-mono text-[9px] mt-1" style={{ color: st.color }}>{fix.note}</div>
          )}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="px-3 pb-3"><DiffView before={fix.before} after={fix.after} /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function HealingProgressPanel({ run }: { run: HealingRun }) {
  if (!run.startedAt) return null;
  const committed = run.fixes.filter(f => f.status === 'committed').length;
  const blocked = run.fixes.filter(f => f.status === 'blocked').length;
  const outcome = run.outcome ? OUTCOME[run.outcome.kind] : null;

  return (
    <div className="h-full flex flex-col bg-[#0a0e1a]/40">
      {/* Phase stepper */}
      <div className="px-5 pt-3 pb-2 border-b border-[#CAAA98]/10 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest">HEALING_PIPELINE</span>
          <span className="font-mono text-[9px] text-[#9A8678]/60">
            elapsed <Elapsed since={run.startedAt} frozen={!!run.outcome} />
          </span>
        </div>
        <div className="flex items-start">
          {PHASES.map((p, i) => {
            const state = run.phases[p.id];
            return (
              <div key={p.id} className="flex-1 flex items-start min-w-0">
                <div className="flex flex-col items-center min-w-0 flex-1" title={p.hint}>
                  <motion.div animate={state === 'active' ? { scale: [1, 1.15, 1] } : { scale: 1 }} transition={{ duration: 1.4, repeat: state === 'active' ? Infinity : 0 }}>
                    <PhaseIcon state={state} />
                  </motion.div>
                  <span className="font-mono text-[8px] tracking-wider mt-1 truncate" style={{ color: phaseColor[state], opacity: state === 'pending' || state === 'skipped' ? 0.45 : 1 }}>
                    {p.label}
                  </span>
                </div>
                {i < PHASES.length - 1 && (
                  <div className="h-px flex-1 mt-[7px] mx-0.5" style={{ backgroundColor: state === 'done' ? C.green + '80' : C.muted + '30' }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-3 space-y-3">
        {/* Outcome banner */}
        <AnimatePresence>
          {outcome && run.outcome && (
            <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="border px-3 py-2 flex items-start gap-2" style={{ borderColor: outcome.color + '50', backgroundColor: outcome.color + '10' }}>
              {run.outcome.kind === 'healed' || run.outcome.kind === 'clean'
                ? <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: outcome.color }} strokeWidth={1.5} />
                : <ShieldAlert className="w-4 h-4 flex-shrink-0" style={{ color: outcome.color }} strokeWidth={1.5} />}
              <div className="min-w-0">
                <div className="font-mono text-[10px] tracking-widest" style={{ color: outcome.color }}>{outcome.label}</div>
                <div className="font-mono text-[10px] text-[#CAAA98]/80 mt-0.5 break-words">{run.outcome.reason}</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* What failed */}
        {run.failure && (
          <div>
            <div className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest mb-1.5">FAILING_PIPELINE</div>
            <div className="flex flex-wrap gap-1.5">
              {run.failure.workflows.map(w => (
                <span key={w} className="font-mono text-[9px] px-2 py-0.5 border border-[#A06A6A]/40 text-[#C98E8E]">{w}</span>
              ))}
              {run.failure.sha && <span className="font-mono text-[9px] px-2 py-0.5 text-[#9A8678]">@{run.failure.sha}</span>}
              {run.failure.url && (
                <a href={run.failure.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-[#9A8678] hover:text-[#CAAA98] flex items-center gap-1">
                  run <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
            </div>
            {run.failure.jobs.length > 0 && (
              <div className="font-mono text-[9px] text-[#9A8678]/70 mt-1.5 break-words">
                jobs: {run.failure.jobs.slice(0, 6).join(', ')}
                {run.failure.steps.length > 0 && <> · steps: {[...new Set(run.failure.steps)].slice(0, 6).join(', ')}</>}
              </div>
            )}
          </div>
        )}

        {/* Diagnosis */}
        {run.categories.length > 0 && (
          <div>
            <div className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest mb-1.5">DIAGNOSED_ROOT_CAUSES</div>
            <div className="flex flex-wrap gap-1.5">
              {run.categories.map((c, i) => (
                <motion.span key={c} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.05 }}
                  className="font-mono text-[9px] px-2 py-0.5 border"
                  style={i === 0 ? { borderColor: C.amber + '70', color: C.amber } : { borderColor: C.muted + '40', color: C.muted }}>
                  {i === 0 ? '◆ ' : ''}{c}
                </motion.span>
              ))}
            </div>
          </div>
        )}

        {/* Fix engine + confidence */}
        {run.engine && (
          <div className="flex items-center gap-3">
            <span className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest">ENGINE</span>
            <span className="font-mono text-[9px] text-[#CAAA98]">{run.engine === 'rules' ? 'deterministic rules' : run.engine === 'ai' ? 'AI analysis' : 'static YAML analysis'}</span>
            {run.confidence !== undefined && (
              <div className="flex items-center gap-2 flex-1 max-w-[180px]">
                <div className="h-1 flex-1 bg-[#202940] overflow-hidden">
                  <motion.div className="h-full" initial={{ width: 0 }} animate={{ width: `${Math.min(100, run.confidence)}%` }}
                    style={{ backgroundColor: run.confidence >= 80 ? C.green : run.confidence >= 65 ? C.amber : C.red }} />
                </div>
                <span className="font-mono text-[9px] text-[#9A8678]">{run.confidence}%</span>
              </div>
            )}
          </div>
        )}

        {/* Fixes */}
        {run.fixes.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest">CHANGES [{run.fixes.length}]</span>
              <span className="font-mono text-[9px] text-[#9A8678]/70">
                {committed > 0 && <span className="text-[#6A9A7A]">{committed} committed</span>}
                {blocked > 0 && <span className="text-[#A06A6A] ml-2">{blocked} blocked</span>}
              </span>
            </div>
            <div className="space-y-1.5">
              {run.fixes.map((f, i) => <FixRow key={`${f.source}:${f.path}`} fix={f} defaultOpen={run.fixes.length <= 2 && i === 0} />)}
            </div>
          </div>
        )}

        {/* Branch / PR / verification */}
        {(run.branch || run.prUrl || run.verify) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1">
            {run.branch && (
              <span className="font-mono text-[9px] text-[#9A8678] flex items-center gap-1"><GitBranch className="w-3 h-3" />{run.branch}</span>
            )}
            {run.prUrl && (
              <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-[9px] text-[#6A9A7A] hover:underline flex items-center gap-1">
                <GitPullRequest className="w-3 h-3" />open pull request<ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
            {run.verify && (
              <span className="font-mono text-[9px] flex items-center gap-1" style={{ color: run.verify === 'success' ? C.green : run.verify === 'failure' ? C.red : C.amber }}>
                {run.verify === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
                CI on fix branch: {run.verify === 'running' ? 'running…' : run.verify === 'success' ? 'green ✓' : run.verify === 'failure' ? 'red — deep diagnosis' : 'still running (check PR)'}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
