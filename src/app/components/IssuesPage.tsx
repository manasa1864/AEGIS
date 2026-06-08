import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Plus, Circle, CheckCircle, Brain, Loader2 } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, Issue } from '../types';
import { timeAgo } from '../lib/utils';
import { callAI, parseJSON } from '../lib/ai';
import {
  getGithubIssues, createGithubIssue, updateGithubIssueState,
  getGitlabIssues, createGitlabIssue, updateGitlabIssueState,
} from '../lib/issues';

interface IssuesPageProps {
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

interface TriageResult {
  type: string;
  priority: string;
  labels: string[];
  summary: string;
  suggestion: string;
}

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#A06A6A',
  high: '#C07060',
  medium: '#D4A574',
  low: '#9A8678',
};

const TYPE_COLOR: Record<string, string> = {
  bug: '#A06A6A',
  security: '#C07060',
  performance: '#D4A574',
  feature: '#6A9A7A',
  question: '#9A8678',
  docs: '#9A8678',
};

export function IssuesPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, geminiKey, groqKey, onAddRepo }: IssuesPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [triageResults, setTriageResults] = useState<Record<number, TriageResult>>({});
  const [triagingId, setTriagingId] = useState<number | null>(null);

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;
  const hasAI = !!(geminiKey || groqKey);

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    try {
      const data = platform === 'gitlab'
        ? await getGitlabIssues(pat, project.owner, project.repoName, filter === 'open' ? 'opened' : 'closed')
        : await getGithubIssues(pat, project.owner, project.repoName, filter);
      setIssues(data);
    } finally {
      setLoading(false);
    }
  }, [project, pat, platform, filter]);

  useEffect(() => { setIssues([]); setTriageResults({}); load(); }, [load]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const handleCreate = async () => {
    if (!newTitle.trim() || !project.owner || !project.repoName) return;
    setCreating(true);
    const created = platform === 'gitlab'
      ? await createGitlabIssue(pat, project.owner, project.repoName, newTitle, newBody)
      : await createGithubIssue(pat, project.owner, project.repoName, newTitle, newBody);
    if (created && filter === 'open') setIssues(prev => [created, ...prev]);
    setNewTitle(''); setNewBody(''); setShowForm(false); setCreating(false);
  };

  const handleToggle = async (issue: Issue) => {
    if (!project.owner || !project.repoName) return;
    setTogglingId(issue.id);
    if (platform === 'gitlab') {
      await updateGitlabIssueState(pat, project.owner, project.repoName, issue.number, issue.state === 'open' ? 'close' : 'reopen');
    } else {
      await updateGithubIssueState(pat, project.owner, project.repoName, issue.number, issue.state === 'open' ? 'closed' : 'open');
    }
    setIssues(prev => prev.filter(i => i.id !== issue.id));
    setTogglingId(null);
  };

  const handleTriage = async (issue: Issue) => {
    setTriagingId(issue.id);
    const prompt = `You are a project manager triaging a software issue.

Issue Title: ${issue.title}
Labels already applied: ${issue.labels.join(', ') || 'none'}
Repository: ${project.name} (language: ${project.language || 'unknown'})

Triage this issue and respond ONLY with JSON (no markdown, no extra text):
{
  "type": "<bug|feature|question|docs|performance|security>",
  "priority": "<critical|high|medium|low>",
  "labels": ["<label1>", "<label2>"],
  "summary": "<one sentence describing the core issue>",
  "suggestion": "<one sentence recommended next action>"
}`;

    const raw = await callAI(geminiKey, groqKey, prompt);
    const parsed = parseJSON<TriageResult>(raw);
    if (parsed) {
      setTriageResults(prev => ({ ...prev, [issue.id]: parsed }));
    }
    setTriagingId(null);
  };

  const isConnected = !!(project.owner && project.repoName);

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">ISSUE_TRACKER</div>
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
            >
              <Plus className="w-3 h-3" strokeWidth={2} /> NEW
            </button>
            <button onClick={load} disabled={loading}
              className="border border-[#9A8678]/30 text-[#9A8678] p-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {!isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">REPO_NOT_CONNECTED</div>}
        {!pat && isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">{platform.toUpperCase()}_PAT not set — add it in settings</div>}

        <AnimatePresence>
          {showForm && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 border border-[#CAAA98]/20 bg-[#0a0e1a]/50 p-4 space-y-3 overflow-hidden"
            >
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Issue title"
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
              />
              <textarea value={newBody} onChange={e => setNewBody(e.target.value)} placeholder="Description (optional)" rows={3}
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30 resize-none"
              />
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={!newTitle.trim() || creating}
                  className="border border-[#CAAA98]/50 text-[#CAAA98] font-mono text-[10px] px-4 py-1.5 hover:bg-[#CAAA98]/10 transition-colors disabled:opacity-40"
                >{creating ? 'CREATING...' : 'CREATE_ISSUE'}</button>
                <button onClick={() => setShowForm(false)} className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[10px] px-3 py-1.5 hover:border-[#9A8678]/40 transition-colors">CANCEL</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-2">
          {loading && issues.length === 0 && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}
          {!loading && issues.length === 0 && pat && isConnected && <div className="font-mono text-[10px] text-[#9A8678]/40">NO_{filter.toUpperCase()}_ISSUES</div>}
          {issues.map(issue => {
            const triage = triageResults[issue.id];
            const isTriaging = triagingId === issue.id;
            return (
              <motion.div key={issue.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40"
              >
                <div className="p-4 flex items-start gap-3">
                  <button onClick={() => handleToggle(issue)} disabled={togglingId === issue.id}
                    className="mt-0.5 flex-shrink-0 hover:opacity-70 transition-opacity disabled:opacity-40"
                  >
                    {issue.state === 'open'
                      ? <Circle className="w-3.5 h-3.5 text-[#6A9A7A]" strokeWidth={2} />
                      : <CheckCircle className="w-3.5 h-3.5 text-[#9A8678]/40" strokeWidth={2} />
                    }
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[9px] text-[#9A8678]/40 flex-shrink-0">#{issue.number}</span>
                      <a href={issue.url} target="_blank" rel="noopener noreferrer"
                        className="font-mono text-xs text-[#CAAA98] hover:text-[#CAAA98]/80 transition-colors truncate"
                      >{issue.title}</a>
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="font-mono text-[9px] text-[#9A8678]/40">{issue.author}</span>
                      {issue.labels.slice(0, 3).map(l => (
                        <span key={l} className="font-mono text-[8px] text-[#9A8678]/50 border border-[#9A8678]/20 px-1.5 py-0.5">{l}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="font-mono text-[9px] text-[#9A8678]/30">{timeAgo(issue.createdAt)}</div>
                    {hasAI && !triage && (
                      <button onClick={() => handleTriage(issue)} disabled={isTriaging}
                        className="flex items-center gap-1 border border-[#9A8678]/20 text-[#9A8678]/40 font-mono text-[9px] px-2 py-0.5 hover:border-[#D4A574]/40 hover:text-[#D4A574] transition-colors disabled:opacity-40"
                      >
                        {isTriaging ? <Loader2 className="w-2.5 h-2.5 animate-spin" strokeWidth={2} /> : <Brain className="w-2.5 h-2.5" strokeWidth={2} />}
                        {isTriaging ? '...' : 'TRIAGE'}
                      </button>
                    )}
                  </div>
                </div>

                {/* AI Triage result */}
                {triage && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
                    className="border-t border-[#CAAA98]/10 px-4 py-3 bg-[#202940]/20"
                  >
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="font-mono text-[8px] tracking-wider px-1.5 py-0.5 border"
                        style={{ color: TYPE_COLOR[triage.type] ?? '#9A8678', borderColor: `${TYPE_COLOR[triage.type] ?? '#9A8678'}40` }}
                      >{triage.type?.toUpperCase()}</span>
                      <span className="font-mono text-[8px] tracking-wider px-1.5 py-0.5 border"
                        style={{ color: PRIORITY_COLOR[triage.priority] ?? '#9A8678', borderColor: `${PRIORITY_COLOR[triage.priority] ?? '#9A8678'}40` }}
                      >{triage.priority?.toUpperCase()}_PRIORITY</span>
                      {triage.labels?.slice(0, 3).map(l => (
                        <span key={l} className="font-mono text-[8px] text-[#9A8678]/50 border border-[#9A8678]/20 px-1.5 py-0.5">{l}</span>
                      ))}
                    </div>
                    <div className="font-mono text-[10px] text-[#CAAA98]/70 leading-relaxed">{triage.summary}</div>
                    <div className="font-mono text-[9px] text-[#D4A574]/60 mt-1.5">→ {triage.suggestion}</div>
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
