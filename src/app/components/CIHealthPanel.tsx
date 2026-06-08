import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight,
  RefreshCw, AlertTriangle, Clock,
} from 'lucide-react';
import { getComprehensiveCI, WorkflowCheckStatus } from '../lib/github';
import { apiGetEvents } from '../lib/backendApi';
import { HealingEventRecord, Project } from '../types';

interface CIHealthPanelProps {
  project: Project;
  pat: string;
}

function conclusionColor(conclusion: string | null, status: string): string {
  if (status !== 'completed') return '#D4A574';
  if (conclusion === 'success') return '#6A9A7A';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') return '#A06A6A';
  return '#9A8678';
}

function conclusionLabel(conclusion: string | null, status: string): string {
  if (status !== 'completed') return 'RUNNING';
  if (conclusion === 'success') return 'PASSING';
  if (conclusion === 'failure') return 'FAILING';
  if (conclusion === 'timed_out') return 'TIMED_OUT';
  if (conclusion === 'cancelled') return 'CANCELLED';
  if (conclusion === 'skipped') return 'SKIPPED';
  return 'UNKNOWN';
}

export function CIHealthPanel({ project, pat }: CIHealthPanelProps) {
  const [checks, setChecks] = useState<WorkflowCheckStatus[]>([]);
  const [lastHealing, setLastHealing] = useState<HealingEventRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!project.owner || !project.repoName || !pat) return;
    setLoading(true);
    try {
      const projectKey = `${project.owner}/${project.repoName}`;
      const [ciChecks, events] = await Promise.all([
        getComprehensiveCI(pat, project.owner, project.repoName),
        apiGetEvents(projectKey).catch(() => [] as HealingEventRecord[]),
      ]);
      setChecks(ciChecks);
      const withDetail = (events as HealingEventRecord[])
        .filter(e => e.root_cause || (e.fix_steps?.length ?? 0) > 0);
      setLastHealing(withDetail[0] ?? null);
    } finally {
      setLoading(false);
    }
  }, [project.owner, project.repoName, pat]);

  useEffect(() => { load(); }, [load]);

  if (!project.owner || !project.repoName || !pat) return null;

  const failing = checks.filter(c => c.conclusion === 'failure');
  const passing = checks.filter(c => c.conclusion === 'success');

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-[#CAAA98]/10 bg-[#0a0e1a]/30 flex-shrink-0">
        <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest">CI_HEALTH_SCAN</div>
        <div className="flex items-center gap-3">
          {!loading && checks.length > 0 && (
            <div className="flex items-center gap-2">
              {failing.length > 0 && (
                <span className="font-mono text-[8px] text-[#A06A6A]">{failing.length} failing</span>
              )}
              {passing.length > 0 && (
                <span className="font-mono text-[8px] text-[#6A9A7A]">{passing.length} passing</span>
              )}
            </div>
          )}
          <button
            onClick={load}
            className="p-1 text-[#9A8678]/30 hover:text-[#CAAA98]/60 transition-colors"
            title="Refresh checks"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {loading && (
          <div className="flex items-center gap-2 px-5 py-3">
            <Loader2 className="w-3 h-3 text-[#9A8678]/40 animate-spin" strokeWidth={1.5} />
            <span className="font-mono text-[9px] text-[#9A8678]/40 tracking-widest">SCANNING_ALL_WORKFLOWS...</span>
          </div>
        )}

        {!loading && checks.length === 0 && (
          <div className="flex items-center gap-2 px-5 py-3">
            <Clock className="w-3 h-3 text-[#9A8678]/30" strokeWidth={1.5} />
            <span className="font-mono text-[9px] text-[#9A8678]/30">No workflow runs found</span>
          </div>
        )}

        {!loading && checks.length > 0 && (
          <div>
            {checks.map((check, i) => {
              const isFail = check.conclusion === 'failure';
              const isExp = expanded === i;
              const color = conclusionColor(check.conclusion, check.status);
              const label = conclusionLabel(check.conclusion, check.status);

              return (
                <div key={check.runId} className="border-b border-[#CAAA98]/5 last:border-0">
                  <button
                    onClick={() => isFail && setExpanded(isExp ? null : i)}
                    className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${isFail ? 'hover:bg-[#A06A6A]/5 cursor-pointer' : 'cursor-default'}`}
                  >
                    {check.status !== 'completed'
                      ? <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" style={{ color }} strokeWidth={1.5} />
                      : isFail
                      ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} strokeWidth={1.5} />
                      : <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} strokeWidth={1.5} />
                    }
                    <span
                      className="flex-1 min-w-0 font-mono text-[10px] truncate"
                      style={{ color: isFail ? '#CAAA98' : '#9A8678' }}
                    >
                      {check.name}
                    </span>
                    <span className="font-mono text-[8px] tracking-wider flex-shrink-0" style={{ color }}>
                      {label}
                    </span>
                    {isFail && (
                      isExp
                        ? <ChevronDown className="w-3 h-3 text-[#9A8678]/40 flex-shrink-0" strokeWidth={1.5} />
                        : <ChevronRight className="w-3 h-3 text-[#9A8678]/40 flex-shrink-0" strokeWidth={1.5} />
                    )}
                  </button>

                  <AnimatePresence>
                    {isExp && isFail && (
                      <motion.div
                        className="overflow-hidden"
                        initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <div className="px-5 pb-4 pt-2 bg-[#A06A6A]/5 space-y-3">

                          {/* Failed jobs & steps */}
                          {check.failedJobs.length > 0 && (
                            <div>
                              <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest mb-2">FAILED_JOBS</div>
                              {check.failedJobs.map((job, ji) => (
                                <div key={ji} className="mb-2">
                                  <div className="flex items-center gap-1.5 font-mono text-[9px] text-[#A06A6A]/80 mb-1">
                                    <XCircle className="w-2.5 h-2.5 flex-shrink-0" strokeWidth={1.5} />
                                    {job.name}
                                  </div>
                                  {job.failedSteps.length > 0
                                    ? job.failedSteps.map((step, si) => (
                                        <div key={si} className="ml-4 flex items-center gap-1 font-mono text-[9px] text-[#9A8678]/50">
                                          <span className="text-[#A06A6A]/40 text-[8px]">└─</span>
                                          <span>{step}</span>
                                        </div>
                                      ))
                                    : <div className="ml-4 font-mono text-[9px] text-[#9A8678]/30">no step details available</div>
                                  }
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Root cause from last healing */}
                          {lastHealing?.root_cause && (
                            <div className="border-t border-[#CAAA98]/8 pt-3">
                              <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest mb-1.5">ROOT_CAUSE</div>
                              <div className="font-mono text-[9px] text-[#CAAA98]/70 leading-relaxed">
                                {lastHealing.root_cause}
                              </div>
                            </div>
                          )}

                          {/* Fix steps from last healing */}
                          {lastHealing?.fix_steps && lastHealing.fix_steps.length > 0 && (
                            <div className="border-t border-[#CAAA98]/8 pt-3">
                              <div className="font-mono text-[8px] text-[#6A9A7A]/50 tracking-widest mb-1.5">HOW_TO_FIX</div>
                              {lastHealing.fix_steps.map((step, si) => (
                                <div key={si} className="flex items-start gap-1.5 font-mono text-[9px] text-[#6A9A7A]/70 mb-1 leading-relaxed">
                                  <span className="flex-shrink-0 text-[#6A9A7A]/50 mt-0.5">▸</span>
                                  <span>{step}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Grounding sources from web search */}
                          {lastHealing?.sources && lastHealing.sources.length > 0 && (
                            <div className="border-t border-[#CAAA98]/8 pt-3">
                              <div className="font-mono text-[8px] text-[#6A9A7A]/50 tracking-widest mb-1.5">GROUNDING_SOURCES</div>
                              {lastHealing.sources.slice(0, 3).map((src, si) => (
                                <div key={si} className="flex items-start gap-1.5 font-mono text-[9px] mb-1">
                                  <span className="flex-shrink-0 text-[#6A9A7A]/40 mt-0.5">↗</span>
                                  <a
                                    href={src.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    className="text-[#6A9A7A]/60 hover:text-[#6A9A7A] transition-colors truncate leading-relaxed"
                                  >
                                    {src.title}
                                  </a>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Link to GitHub */}
                          <div className="border-t border-[#CAAA98]/8 pt-2">
                            <a
                              href={check.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={e => e.stopPropagation()}
                              className="font-mono text-[8px] text-[#9A8678]/30 hover:text-[#CAAA98]/60 transition-colors tracking-wider"
                            >
                              VIEW_ON_GITHUB ↗
                            </a>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer hint when failures exist and no fix recorded */}
        {!loading && failing.length > 0 && !lastHealing?.fix_steps?.length && (
          <div className="flex items-center gap-1.5 px-5 py-2.5 border-t border-[#CAAA98]/5 mt-auto">
            <AlertTriangle className="w-3 h-3 text-[#D4A574]/40 flex-shrink-0" strokeWidth={1.5} />
            <span className="font-mono text-[8px] text-[#D4A574]/40 leading-relaxed">
              Run healing to auto-analyze and fix the failing checks
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
