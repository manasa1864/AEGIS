import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Plus, GitMerge, X, Brain, Loader2 } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, PullRequest } from '../types';
import { timeAgo } from '../lib/utils';
import { callAI, parseJSON } from '../lib/ai';
import {
  getGithubPRs, createGithubPR, mergeGithubPR, closeGithubPR, getGithubPRDiff,
  getGitlabMRs, createGitlabMR, mergeGitlabMR, closeGitlabMR,
} from '../lib/prs';

interface PullRequestsPageProps {
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

interface ReviewResult {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  summary: string;
  issues: Array<{ severity: 'critical' | 'major' | 'minor'; finding: string }>;
}

const VERDICT_COLOR: Record<string, string> = {
  APPROVE: '#6A9A7A',
  REQUEST_CHANGES: '#A06A6A',
  COMMENT: '#D4A574',
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#A06A6A',
  major: '#D4A574',
  minor: '#9A8678',
};

function prStateColor(state: PullRequest['state']): string {
  if (state === 'merged') return '#9A6A9A';
  if (state === 'closed') return '#A06A6A';
  return '#6A9A7A';
}

export function PullRequestsPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, geminiKey, groqKey, onAddRepo }: PullRequestsPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', head: '', base: 'main' });
  const [creating, setCreating] = useState(false);
  const [reviewResults, setReviewResults] = useState<Record<number, ReviewResult>>({});
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [expandedReview, setExpandedReview] = useState<number | null>(null);

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;
  const prLabel = platform === 'gitlab' ? 'MR' : 'PR';
  const hasAI = !!(geminiKey || groqKey);

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    try {
      const data = platform === 'gitlab'
        ? await getGitlabMRs(pat, project.owner, project.repoName, filter === 'open' ? 'opened' : 'closed')
        : await getGithubPRs(pat, project.owner, project.repoName, filter);
      setPrs(data);
    } finally {
      setLoading(false);
    }
  }, [project, pat, platform, filter]);

  useEffect(() => { setPrs([]); setReviewResults({}); load(); }, [load]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);

  const act = async (fn: () => Promise<boolean>, id: number) => {
    setActionId(id);
    await fn();
    setTimeout(load, 1500);
    setActionId(null);
  };

  const handleCreate = async () => {
    if (!form.title.trim() || !form.head.trim() || !project.owner || !project.repoName) return;
    setCreating(true);
    const created = platform === 'gitlab'
      ? await createGitlabMR(pat, project.owner, project.repoName, form.title, form.body, form.head, form.base)
      : await createGithubPR(pat, project.owner, project.repoName, form.title, form.body, form.head, form.base);
    if (created && filter === 'open') setPrs(prev => [created, ...prev]);
    setForm({ title: '', body: '', head: '', base: 'main' });
    setShowForm(false);
    setCreating(false);
  };

  const handleReview = async (pr: PullRequest) => {
    if (!project.owner || !project.repoName) return;
    setReviewingId(pr.id);

    // Only GitHub supports diff via API
    let diffText = '';
    if (platform === 'github') {
      const raw = await getGithubPRDiff(pat, project.owner, project.repoName, pr.number);
      diffText = raw.slice(0, 4000); // truncate to keep prompt manageable
    }

    const prompt = `You are a senior code reviewer. Review this ${prLabel}.

Title: ${pr.title}
Author: ${pr.author}
Branch: ${pr.sourceBranch} → ${pr.targetBranch}
${diffText ? `\nDiff (truncated):\n\`\`\`\n${diffText}\n\`\`\`` : '\n(Diff not available for this platform — review based on context only.)'}

Provide a concise, direct code review. Respond ONLY with JSON (no markdown, no extra text):
{
  "verdict": "<APPROVE|REQUEST_CHANGES|COMMENT>",
  "summary": "<one sentence overall assessment>",
  "issues": [
    { "severity": "<critical|major|minor>", "finding": "<specific finding>" }
  ]
}

If the diff is empty or unavailable, base your verdict on the branch names and title only. Keep issues array to 3 or fewer entries.`;

    const raw = await callAI(geminiKey, groqKey, prompt);
    const parsed = parseJSON<ReviewResult>(raw);
    if (parsed) {
      setReviewResults(prev => ({ ...prev, [pr.id]: parsed }));
      setExpandedReview(pr.id);
    }
    setReviewingId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">{prLabel}_MANAGER</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex">
              {(['open', 'closed'] as const).map(f => (
                <button key={f} onClick={() => setFilter(f)}
                  className={`font-mono text-[9px] tracking-wider px-3 py-1.5 border transition-all ${filter === f ? 'border-[#CAAA98]/50 text-[#CAAA98] bg-[#CAAA98]/10' : 'border-[#9A8678]/20 text-[#9A8678]/40 hover:text-[#9A8678]/70'}`}
                >{f.toUpperCase()}</button>
              ))}
            </div>
            <button onClick={() => setShowForm(v => !v)}
              className="flex items-center gap-1.5 border border-[#CAAA98]/30 text-[#CAAA98] font-mono text-[10px] px-3 py-1.5 hover:bg-[#CAAA98]/10 transition-colors"
            ><Plus className="w-3 h-3" strokeWidth={2} /> NEW {prLabel}</button>
            <button onClick={load} disabled={loading}
              className="border border-[#9A8678]/30 text-[#9A8678] p-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
            ><RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /></button>
          </div>
        </div>

        {!isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">REPO_NOT_CONNECTED</div>}
        {!pat && isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">{platform.toUpperCase()}_PAT not set — add it in settings</div>}

        <AnimatePresence>
          {showForm && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 border border-[#CAAA98]/20 bg-[#0a0e1a]/50 p-4 space-y-3 overflow-hidden"
            >
              <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder={`${prLabel} title`}
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
              />
              <div className="flex gap-2">
                <input value={form.head} onChange={e => setForm(f => ({ ...f, head: e.target.value }))} placeholder="source branch"
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
                />
                <div className="font-mono text-[10px] text-[#9A8678]/40 flex items-center">→</div>
                <input value={form.base} onChange={e => setForm(f => ({ ...f, base: e.target.value }))} placeholder="target branch"
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
                />
              </div>
              <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="Description (optional)" rows={3}
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30 resize-none"
              />
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={!form.title.trim() || !form.head.trim() || creating}
                  className="border border-[#CAAA98]/50 text-[#CAAA98] font-mono text-[10px] px-4 py-1.5 hover:bg-[#CAAA98]/10 transition-colors disabled:opacity-40"
                >{creating ? 'CREATING...' : `CREATE_${prLabel}`}</button>
                <button onClick={() => setShowForm(false)} className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[10px] px-3 py-1.5 hover:border-[#9A8678]/40 transition-colors">CANCEL</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-2">
          {loading && prs.length === 0 && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}
          {!loading && prs.length === 0 && pat && isConnected && <div className="font-mono text-[10px] text-[#9A8678]/40">NO_{filter.toUpperCase()}_{prLabel}S</div>}
          {prs.map(pr => {
            const color = prStateColor(pr.state);
            const review = reviewResults[pr.id];
            const isReviewing = reviewingId === pr.id;
            return (
              <motion.div key={pr.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40"
              >
                <div className="p-4 flex items-start gap-3">
                  <div className="mt-0.5 flex-shrink-0 w-3.5 h-3.5 rounded-full border-2" style={{ borderColor: color }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[9px] text-[#9A8678]/40 flex-shrink-0">#{pr.number}</span>
                      <a href={pr.url} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-xs text-[#CAAA98] hover:text-[#CAAA98]/80 transition-colors truncate"
                      >{pr.title}</a>
                      {pr.draft && <span className="font-mono text-[8px] text-[#9A8678]/40 border border-[#9A8678]/20 px-1 py-0.5 flex-shrink-0">DRAFT</span>}
                    </div>
                    <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1">
                      {pr.sourceBranch} → {pr.targetBranch} · {pr.author}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                    <span className="font-mono text-[9px]" style={{ color }}>{pr.state}</span>
                    <span className="font-mono text-[9px] text-[#9A8678]/30">{timeAgo(pr.createdAt)}</span>
                    {/* AI Review button — GitHub only (diff API), shown for open PRs */}
                    {hasAI && platform === 'github' && !review && (
                      <button onClick={() => handleReview(pr)} disabled={isReviewing}
                        className="flex items-center gap-1 border border-[#9A8678]/20 text-[#9A8678]/40 font-mono text-[9px] px-2 py-0.5 hover:border-[#D4A574]/40 hover:text-[#D4A574] transition-colors disabled:opacity-40"
                      >
                        {isReviewing ? <Loader2 className="w-2.5 h-2.5 animate-spin" strokeWidth={2} /> : <Brain className="w-2.5 h-2.5" strokeWidth={2} />}
                        {isReviewing ? '...' : 'AI REVIEW'}
                      </button>
                    )}
                    {review && (
                      <button onClick={() => setExpandedReview(expandedReview === pr.id ? null : pr.id)}
                        className="font-mono text-[9px] px-2 py-0.5 border transition-colors"
                        style={{ color: VERDICT_COLOR[review.verdict], borderColor: `${VERDICT_COLOR[review.verdict]}40` }}
                      >{review.verdict}</button>
                    )}
                    {pr.state === 'open' && (
                      <>
                        <button
                          onClick={() => act(
                            () => platform === 'gitlab' ? mergeGitlabMR(pat, project.owner!, project.repoName!, pr.number) : mergeGithubPR(pat, project.owner!, project.repoName!, pr.number),
                            pr.id
                          )}
                          disabled={actionId === pr.id || pr.draft}
                          className="flex items-center gap-1 border border-[#9A6A9A]/30 text-[#9A6A9A] font-mono text-[9px] px-2 py-1 hover:bg-[#9A6A9A]/10 transition-colors disabled:opacity-40"
                        ><GitMerge className="w-2.5 h-2.5" strokeWidth={2} /> MERGE</button>
                        <button
                          onClick={() => act(
                            () => platform === 'gitlab' ? closeGitlabMR(pat, project.owner!, project.repoName!, pr.number) : closeGithubPR(pat, project.owner!, project.repoName!, pr.number),
                            pr.id
                          )}
                          disabled={actionId === pr.id}
                          className="flex items-center gap-1 border border-[#A06A6A]/30 text-[#A06A6A] font-mono text-[9px] px-2 py-1 hover:bg-[#A06A6A]/10 transition-colors disabled:opacity-40"
                        ><X className="w-2.5 h-2.5" strokeWidth={2} /> CLOSE</button>
                      </>
                    )}
                  </div>
                </div>

                {/* AI Review panel */}
                <AnimatePresence>
                  {review && expandedReview === pr.id && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                      className="border-t border-[#CAAA98]/10 px-4 py-3 bg-[#202940]/20 overflow-hidden"
                    >
                      <div className="font-mono text-[10px] text-[#CAAA98]/70 mb-2 leading-relaxed">{review.summary}</div>
                      {review.issues?.length > 0 && (
                        <div className="space-y-1.5">
                          {review.issues.map((issue, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span className="font-mono text-[8px] px-1.5 py-0.5 border flex-shrink-0 mt-0.5"
                                style={{ color: SEVERITY_COLOR[issue.severity], borderColor: `${SEVERITY_COLOR[issue.severity]}40` }}
                              >{issue.severity?.toUpperCase()}</span>
                              <span className="font-mono text-[10px] text-[#9A8678]/70">{issue.finding}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
