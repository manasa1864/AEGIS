import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Play, Square, Zap, AlertTriangle, Brain, Loader2, ChevronDown, ChevronRight, CheckCircle, XCircle, Clock, Circle } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, CIRun, CIPipeline } from '../types';
import { timeAgo } from '../lib/utils';
import { callAI } from '../lib/ai';
import { WorkflowJob } from '../lib/github';
import {
  getGithubRuns, rerunGithubRun, cancelGithubRun,
  getGitlabPipelines, retryGitlabPipeline, cancelGitlabPipeline, triggerGitlabPipeline,
} from '../lib/cicd';
import { getRunJobs } from '../lib/github';

interface CICDPageProps {
  projects: Project[];
  selectedProject: string | null;
  onSelectProject: (id: string) => void;
  onClearProject: () => void;
  githubPat: string;
  gitlabPat: string;
  geminiKey: string;
  groqKey: string;
  onAddRepo?: (url: string) => Promise<void>;
}

function ciColor(status: string, conclusion: string | null): string {
  if (status === 'in_progress' || status === 'running' || status === 'pending') return '#D4A574';
  if (conclusion === 'success' || status === 'success') return '#6A9A7A';
  if (conclusion === 'failure' || status === 'failed') return '#A06A6A';
  return '#9A8678';
}

function stepIcon(conclusion: string | null) {
  if (conclusion === 'success') return <CheckCircle className="w-2.5 h-2.5 text-[#6A9A7A]" strokeWidth={2} />;
  if (conclusion === 'failure') return <XCircle className="w-2.5 h-2.5 text-[#A06A6A]" strokeWidth={2} />;
  if (conclusion === 'skipped') return <Circle className="w-2.5 h-2.5 text-[#9A8678]/30" strokeWidth={1.5} />;
  return <Circle className="w-2.5 h-2.5 text-[#D4A574]" strokeWidth={1.5} />;
}

function durationSec(start?: string, end?: string): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function detectAnomaly(runs: CIRun[], pipelines: CIPipeline[]): string | null {
  if (runs.length >= 3) {
    const recent = runs.slice(0, 5);
    const failures = recent.filter(r => r.conclusion === 'failure').length;
    if (failures >= 3) return `${failures} of last ${recent.length} workflow runs failed`;
  }
  if (pipelines.length >= 3) {
    const recent = pipelines.slice(0, 5);
    const failures = recent.filter(p => p.status === 'failed').length;
    if (failures >= 3) return `${failures} of last ${recent.length} pipelines failed`;
  }
  return null;
}

export function CICDPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, geminiKey, groqKey, onAddRepo }: CICDPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [runs, setRuns]             = useState<CIRun[]>([]);
  const [pipelines, setPipelines]   = useState<CIPipeline[]>([]);
  const [loading, setLoading]       = useState(false);
  const [actionId, setActionId]     = useState<number | null>(null);
  const [triggerBranch, setTriggerBranch] = useState('');
  const [triggerMsg, setTriggerMsg] = useState('');
  const [anomalyExplanation, setAnomalyExplanation] = useState('');
  const [explainingAnomaly, setExplainingAnomaly]   = useState(false);

  // Job breakdown state
  const [expandedRunId, setExpandedRunId]               = useState<number | null>(null);
  const [runJobs, setRunJobs]                           = useState<Record<number, WorkflowJob[]>>({});
  const [loadingJobsId, setLoadingJobsId]               = useState<number | null>(null);

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    setAnomalyExplanation('');
    try {
      if (platform === 'gitlab') {
        setPipelines(await getGitlabPipelines(pat, project.owner, project.repoName));
      } else {
        setRuns(await getGithubRuns(pat, project.owner, project.repoName));
      }
    } finally {
      setLoading(false);
    }
  }, [project, pat, platform]);

  useEffect(() => { setRuns([]); setPipelines([]); setExpandedRunId(null); setRunJobs({}); load(); }, [load]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);
  const anomaly = detectAnomaly(runs, pipelines);

  const explainAnomaly = async () => {
    if (!anomaly) return;
    setExplainingAnomaly(true);
    const failedRuns  = runs.filter(r => r.conclusion === 'failure').slice(0, 3);
    const failedPipes = pipelines.filter(p => p.status === 'failed').slice(0, 3);
    const context = platform === 'github'
      ? failedRuns.map(r => `- "${r.name}" on branch ${r.branch}: ${r.commitMsg || '(no message)'}`).join('\n')
      : failedPipes.map(p => `- pipeline #${p.id} on ref ${p.ref}`).join('\n');

    const prompt = `A CI/CD pipeline has a high failure rate: ${anomaly}.

Failed runs:
${context}

In 2-3 sentences, explain the most likely cause of this pattern and suggest one concrete next step to investigate. Be direct and specific.`;

    const explanation = await callAI(geminiKey, groqKey, prompt);
    setAnomalyExplanation(explanation.trim());
    setExplainingAnomaly(false);
  };

  const act = async (fn: () => Promise<boolean>, id: number) => {
    setActionId(id);
    await fn();
    setTimeout(load, 1500);
    setActionId(null);
  };

  const handleTrigger = async () => {
    if (!triggerBranch.trim() || !project.owner || !project.repoName) return;
    setTriggerMsg('triggering...');
    const ok = await triggerGitlabPipeline(pat, project.owner, project.repoName, triggerBranch.trim());
    setTriggerMsg(ok ? 'triggered!' : 'failed');
    setTimeout(() => setTriggerMsg(''), 3000);
    setTimeout(load, 2000);
  };

  const toggleJobExpand = async (runId: number) => {
    if (expandedRunId === runId) { setExpandedRunId(null); return; }
    setExpandedRunId(runId);
    if (runJobs[runId]) return;
    if (!project.owner || !project.repoName) return;
    setLoadingJobsId(runId);
    const jobs = await getRunJobs(pat, project.owner, project.repoName, runId);
    setRunJobs(prev => ({ ...prev, [runId]: jobs }));
    setLoadingJobsId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">CI/CD_PIPELINE_CONTROL</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {platform === 'gitlab' && (
              <div className="flex items-center gap-1.5">
                <input value={triggerBranch} onChange={e => setTriggerBranch(e.target.value)}
                  placeholder="branch" onKeyDown={e => e.key === 'Enter' && handleTrigger()}
                  className="bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-1.5 px-3 font-mono text-[10px] focus:outline-none focus:border-[#CAAA98]/60 w-28 placeholder:text-[#9A8678]/30"
                />
                <button onClick={handleTrigger} disabled={!triggerBranch.trim()}
                  className="flex items-center gap-1.5 border border-[#6A9A7A]/40 text-[#6A9A7A] font-mono text-[10px] px-3 py-1.5 hover:bg-[#6A9A7A]/10 transition-colors disabled:opacity-40"
                >
                  <Zap className="w-3 h-3" strokeWidth={1.5} />
                  {triggerMsg || 'TRIGGER'}
                </button>
              </div>
            )}
            <button onClick={load} disabled={loading}
              className="flex items-center gap-1.5 border border-[#9A8678]/30 text-[#9A8678] font-mono text-[10px] px-3 py-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /> REFRESH
            </button>
          </div>
        </div>

        {!isConnected && (
          <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3 mb-4">
            REPO_NOT_CONNECTED — re-add with a full URL to enable live data
          </div>
        )}
        {!pat && isConnected && (
          <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3 mb-4">
            {platform.toUpperCase()}_PAT not set — add it in settings
          </div>
        )}

        {/* AI Anomaly Detection Banner */}
        {!loading && anomaly && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
            className="mb-4 border border-[#A06A6A]/30 bg-[#A06A6A]/5 px-4 py-3"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-[#A06A6A] flex-shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[10px] text-[#A06A6A]">HIGH_FAILURE_RATE :: {anomaly}</span>
              </div>
              {(geminiKey || groqKey) && !anomalyExplanation && (
                <button onClick={explainAnomaly} disabled={explainingAnomaly}
                  className="flex items-center gap-1.5 border border-[#D4A574]/30 text-[#D4A574] font-mono text-[9px] px-2.5 py-1 hover:bg-[#D4A574]/10 transition-colors disabled:opacity-50 flex-shrink-0"
                >
                  {explainingAnomaly ? <Loader2 className="w-2.5 h-2.5 animate-spin" strokeWidth={2} /> : <Brain className="w-2.5 h-2.5" strokeWidth={2} />}
                  {explainingAnomaly ? 'THINKING...' : 'AI EXPLAIN'}
                </button>
              )}
            </div>
            {anomalyExplanation && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="mt-3 pt-3 border-t border-[#A06A6A]/20 font-mono text-[10px] text-[#CAAA98]/70 leading-relaxed"
              >
                {anomalyExplanation}
              </motion.div>
            )}
          </motion.div>
        )}

        {/* GitHub Actions runs with expandable job breakdown */}
        {platform === 'github' && (
          <div className="space-y-2">
            {loading && runs.length === 0 && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}
            {!loading && runs.length === 0 && pat && isConnected && <div className="font-mono text-[10px] text-[#9A8678]/40">NO_WORKFLOW_RUNS found</div>}
            {runs.map(run => {
              const color = ciColor(run.status, run.conclusion);
              const isRunning = run.status === 'in_progress' || run.status === 'queued';
              const isFailed  = run.conclusion === 'failure';
              const isOpen    = expandedRunId === run.id;
              const jobs      = runJobs[run.id] ?? [];
              const isLoadingJobs = loadingJobsId === run.id;

              return (
                <motion.div key={run.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40"
                >
                  {/* Run summary row */}
                  <div className="p-4 flex items-center gap-3">
                    {/* Expand toggle */}
                    <button onClick={() => toggleJobExpand(run.id)}
                      className="text-[#9A8678]/30 hover:text-[#9A8678]/70 transition-colors flex-shrink-0"
                    >
                      {isOpen
                        ? <ChevronDown className="w-3 h-3" strokeWidth={1.5} />
                        : <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
                      }
                    </button>

                    <motion.div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }}
                      animate={isRunning ? { opacity: [0.4, 1, 0.4] } : {}} transition={{ duration: 1.2, repeat: Infinity }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-[#CAAA98] truncate">{run.name}</div>
                      <div className="font-mono text-[9px] text-[#9A8678]/50 mt-0.5 truncate">{run.branch} · {run.commitMsg || '—'}</div>
                    </div>
                    <div className="font-mono text-[9px] flex-shrink-0" style={{ color }}>{run.conclusion ?? run.status}</div>
                    <div className="font-mono text-[9px] text-[#9A8678]/40 flex-shrink-0">{timeAgo(run.createdAt)}</div>
                    <div className="flex gap-1.5 flex-shrink-0">
                      {isFailed && (
                        <button onClick={() => act(() => rerunGithubRun(pat, project.owner!, project.repoName!, run.id), run.id)} disabled={actionId === run.id}
                          className="flex items-center gap-1 border border-[#6A9A7A]/30 text-[#6A9A7A] font-mono text-[9px] px-2 py-1 hover:bg-[#6A9A7A]/10 transition-colors disabled:opacity-40"
                        >
                          <Play className="w-2.5 h-2.5" strokeWidth={2} /> RE-RUN
                        </button>
                      )}
                      {isRunning && (
                        <button onClick={() => act(() => cancelGithubRun(pat, project.owner!, project.repoName!, run.id), run.id)} disabled={actionId === run.id}
                          className="flex items-center gap-1 border border-[#A06A6A]/30 text-[#A06A6A] font-mono text-[9px] px-2 py-1 hover:bg-[#A06A6A]/10 transition-colors disabled:opacity-40"
                        >
                          <Square className="w-2.5 h-2.5" strokeWidth={2} /> CANCEL
                        </button>
                      )}
                      <a href={run.url} target="_blank" rel="noopener noreferrer"
                        className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[9px] px-2 py-1 hover:border-[#9A8678]/40 hover:text-[#9A8678] transition-colors"
                      >VIEW</a>
                    </div>
                  </div>

                  {/* Expandable job breakdown */}
                  <AnimatePresence>
                    {isOpen && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                        className="border-t border-[#CAAA98]/10 overflow-hidden"
                      >
                        {isLoadingJobs ? (
                          <div className="px-8 py-3 font-mono text-[9px] text-[#9A8678]/40 flex items-center gap-2">
                            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} /> loading jobs...
                          </div>
                        ) : jobs.length === 0 ? (
                          <div className="px-8 py-3 font-mono text-[9px] text-[#9A8678]/40">no job data available</div>
                        ) : (
                          <div className="divide-y divide-[#CAAA98]/5">
                            {jobs.map(job => {
                              const jobColor = ciColor(job.conclusion ? 'done' : 'in_progress', job.conclusion || null);
                              const jobDur   = durationSec(job.startedAt, job.completedAt);
                              const failedSteps = job.steps.filter(s => s.conclusion === 'failure');
                              return (
                                <div key={job.id} className="px-8 py-3">
                                  {/* Job header */}
                                  <div className="flex items-center gap-2 mb-2">
                                    <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: jobColor }} />
                                    <span className="font-mono text-[10px] text-[#CAAA98]/80 flex-1">{job.name}</span>
                                    {jobDur && (
                                      <div className="flex items-center gap-1 font-mono text-[8px] text-[#9A8678]/35">
                                        <Clock className="w-2 h-2" strokeWidth={1.5} /> {jobDur}
                                      </div>
                                    )}
                                    <span className="font-mono text-[8px] flex-shrink-0" style={{ color: jobColor }}>
                                      {job.conclusion || 'running'}
                                    </span>
                                  </div>
                                  {/* Show only failed steps to keep UI clean, or all steps if ≤8 */}
                                  <div className="space-y-1 pl-4">
                                    {(failedSteps.length > 0 ? job.steps : job.steps.slice(0, 8)).map(step => {
                                      const stepDur = durationSec(step.startedAt, step.completedAt);
                                      return (
                                        <div key={step.number} className="flex items-center gap-2">
                                          <div className="flex-shrink-0">{stepIcon(step.conclusion)}</div>
                                          <span className={`font-mono text-[9px] flex-1 truncate ${step.conclusion === 'failure' ? 'text-[#A06A6A]' : step.conclusion === 'success' ? 'text-[#9A8678]/60' : 'text-[#9A8678]/40'}`}>
                                            {step.name}
                                          </span>
                                          {stepDur && <span className="font-mono text-[8px] text-[#9A8678]/25 flex-shrink-0">{stepDur}</span>}
                                        </div>
                                      );
                                    })}
                                    {failedSteps.length === 0 && job.steps.length > 8 && (
                                      <div className="font-mono text-[8px] text-[#9A8678]/30">+{job.steps.length - 8} more steps</div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}

        {/* GitLab Pipelines */}
        {platform === 'gitlab' && (
          <div className="space-y-2">
            {loading && pipelines.length === 0 && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}
            {!loading && pipelines.length === 0 && pat && isConnected && <div className="font-mono text-[10px] text-[#9A8678]/40">NO_PIPELINES found</div>}
            {pipelines.map(p => {
              const color = ciColor(p.status, null);
              const isRunning = p.status === 'running' || p.status === 'pending';
              const isFailed  = p.status === 'failed';
              return (
                <motion.div key={p.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40 p-4 flex items-center gap-4"
                >
                  <motion.div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }}
                    animate={isRunning ? { opacity: [0.4, 1, 0.4] } : {}} transition={{ duration: 1.2, repeat: Infinity }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-[#CAAA98]">pipeline #{p.id}</div>
                    <div className="font-mono text-[9px] text-[#9A8678]/50 mt-0.5">{p.ref}</div>
                  </div>
                  <div className="font-mono text-[9px] flex-shrink-0" style={{ color }}>{p.status}</div>
                  <div className="font-mono text-[9px] text-[#9A8678]/40 flex-shrink-0">{timeAgo(p.createdAt)}</div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    {isFailed && (
                      <button onClick={() => act(() => retryGitlabPipeline(pat, project.owner!, project.repoName!, p.id), p.id)} disabled={actionId === p.id}
                        className="flex items-center gap-1 border border-[#6A9A7A]/30 text-[#6A9A7A] font-mono text-[9px] px-2 py-1 hover:bg-[#6A9A7A]/10 transition-colors disabled:opacity-40"
                      >
                        <Play className="w-2.5 h-2.5" strokeWidth={2} /> RETRY
                      </button>
                    )}
                    {isRunning && (
                      <button onClick={() => act(() => cancelGitlabPipeline(pat, project.owner!, project.repoName!, p.id), p.id)} disabled={actionId === p.id}
                        className="flex items-center gap-1 border border-[#A06A6A]/30 text-[#A06A6A] font-mono text-[9px] px-2 py-1 hover:bg-[#A06A6A]/10 transition-colors disabled:opacity-40"
                      >
                        <Square className="w-2.5 h-2.5" strokeWidth={2} /> CANCEL
                      </button>
                    )}
                    <a href={p.url} target="_blank" rel="noopener noreferrer"
                      className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[9px] px-2 py-1 hover:border-[#9A8678]/40 hover:text-[#9A8678] transition-colors"
                    >VIEW</a>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
