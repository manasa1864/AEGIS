import { useState } from 'react';
import { motion } from 'motion/react';
import { Brain, Loader2, TrendingUp, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project } from '../types';
import { callAI, parseJSON } from '../lib/ai';
import { getGithubRuns, getGitlabPipelines } from '../lib/cicd';
import { getGithubPRs, getGitlabMRs } from '../lib/prs';

interface InsightsPageProps {
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

interface HealthReport {
  score: number;
  summary: string;
  findings: string[];
  recommendations: string[];
  risks: string[];
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 8 ? '#6A9A7A' : score >= 5 ? '#D4A574' : '#A06A6A';
  return (
    <div className="flex items-center gap-3">
      <div className="font-mono text-4xl font-bold" style={{ color }}>{score}</div>
      <div className="font-mono text-[10px] text-[#9A8678]/50">/10</div>
    </div>
  );
}

function Section({ title, items, icon: Icon, color }: { title: string; items: string[]; icon: React.ElementType; color: string }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} strokeWidth={1.5} />
        <div className="font-mono text-[10px] tracking-widest" style={{ color }}>{title}</div>
      </div>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <motion.div key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
            className="flex gap-2 font-mono text-[11px] text-[#CAAA98]/80 border-l border-[#CAAA98]/15 pl-3"
          >
            <span className="text-[#9A8678]/30 flex-shrink-0">›</span>
            {item}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

export function InsightsPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, geminiKey, groqKey, onAddRepo }: InsightsPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;
  const hasAI = !!(geminiKey || groqKey);

  const generate = async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    setError('');
    setReport(null);

    try {
      const { owner, repoName } = project;

      // Gather data in parallel
      const [runsOrPipelines, prs] = await Promise.all([
        platform === 'gitlab'
          ? getGitlabPipelines(pat, owner, repoName)
          : getGithubRuns(pat, owner, repoName),
        platform === 'gitlab'
          ? getGitlabMRs(pat, owner, repoName, 'opened')
          : getGithubPRs(pat, owner, repoName, 'open'),
      ]);

      // Summarise CI health
      let ciSummary: string;
      if (platform === 'github') {
        const runs = runsOrPipelines as Awaited<ReturnType<typeof getGithubRuns>>;
        const recent = runs.slice(0, 10);
        const success = recent.filter(r => r.conclusion === 'success').length;
        const failed = recent.filter(r => r.conclusion === 'failure').length;
        const inProgress = recent.filter(r => r.status === 'in_progress').length;
        const failedNames = runs.filter(r => r.conclusion === 'failure').slice(0, 3).map(r => r.name);
        ciSummary = `Recent GitHub Actions runs (last ${recent.length}): ${success} success, ${failed} failed, ${inProgress} in-progress. Failed workflows: ${failedNames.join(', ') || 'none'}.`;
      } else {
        const pipes = runsOrPipelines as Awaited<ReturnType<typeof getGitlabPipelines>>;
        const recent = pipes.slice(0, 10);
        const success = recent.filter(p => p.status === 'success').length;
        const failed = recent.filter(p => p.status === 'failed').length;
        ciSummary = `Recent GitLab pipelines (last ${recent.length}): ${success} success, ${failed} failed.`;
      }

      const openPRs = prs.length;

      const prompt = `You are a software engineering analyst. Analyze this repository's health metrics and produce a structured report.

Repository: ${project.name}
Platform: ${platform}
Language: ${project.language || 'unknown'}
Stars: ${project.stars ?? 'N/A'} | Forks: ${project.forks ?? 'N/A'}
Open Issues: ${project.openIssues ?? 'N/A'}
Open ${platform === 'gitlab' ? 'Merge Requests' : 'Pull Requests'}: ${openPRs}
Description: ${project.description || 'not provided'}

CI/CD Status:
${ciSummary}

Based on these metrics, produce a health report. Be specific, actionable, and concise.

Respond ONLY with this JSON (no markdown, no extra text):
{
  "score": <integer 1-10>,
  "summary": "<one sentence overall assessment>",
  "findings": ["<finding 1>", "<finding 2>", "<finding 3>"],
  "recommendations": ["<action 1>", "<action 2>", "<action 3>"],
  "risks": ["<risk 1>", "<risk 2>"]
}`;

      const raw = await callAI(geminiKey, groqKey, prompt);
      const parsed = parseJSON<HealthReport>(raw);

      if (!parsed || typeof parsed.score !== 'number') {
        setError('AI returned an unexpected format — try again');
      } else {
        setReport(parsed);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown error');
    } finally {
      setLoading(false);
    }
  };

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">AI_INSIGHTS</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
            </div>
          </div>
          <button
            onClick={generate}
            disabled={loading || !isConnected || !pat || !hasAI}
            className="flex items-center gap-2 border border-[#CAAA98]/40 text-[#CAAA98] font-mono text-[10px] px-4 py-2 hover:bg-[#CAAA98]/10 transition-colors disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} /> : <Brain className="w-3.5 h-3.5" strokeWidth={1.5} />}
            {loading ? 'ANALYSING...' : report ? 'REGENERATE' : 'GENERATE HEALTH REPORT'}
          </button>
        </div>

        {/* Guard messages */}
        {!isConnected && (
          <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3 mb-4">REPO_NOT_CONNECTED</div>
        )}
        {!pat && isConnected && (
          <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3 mb-4">{platform.toUpperCase()}_PAT not set — add it in settings</div>
        )}
        {!hasAI && isConnected && pat && (
          <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3 mb-4">AI key required — add Gemini or Groq key in settings</div>
        )}

        {error && (
          <div className="font-mono text-[10px] text-[#A06A6A] border border-[#A06A6A]/20 px-4 py-3 mb-4">{error}</div>
        )}

        {/* Empty state */}
        {!report && !loading && !error && isConnected && pat && hasAI && (
          <div className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40 p-8 flex flex-col items-center gap-4 text-center">
            <Brain className="w-8 h-8 text-[#9A8678]/20" strokeWidth={1} />
            <div className="font-mono text-[10px] text-[#9A8678]/40 max-w-xs leading-relaxed">
              Click GENERATE HEALTH REPORT to get an AI-powered analysis of your repository's CI health, open issues, pull requests, and more.
            </div>
          </div>
        )}

        {/* Report */}
        {report && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {/* Score + summary */}
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/40 p-6 mb-6 flex items-center gap-6">
              <div className="flex-shrink-0">
                <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest mb-1">HEALTH_SCORE</div>
                <ScoreBadge score={report.score} />
              </div>
              <div className="border-l border-[#CAAA98]/10 pl-6">
                <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest mb-2">ASSESSMENT</div>
                <div className="font-mono text-xs text-[#CAAA98]/80 leading-relaxed">{report.summary}</div>
              </div>
            </div>

            <div className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40 p-6 space-y-2">
              {report.findings?.length > 0 && (
                <Section title="KEY_FINDINGS" items={report.findings} icon={TrendingUp} color="#CAAA98" />
              )}
              {report.recommendations?.length > 0 && (
                <Section title="RECOMMENDATIONS" items={report.recommendations} icon={CheckCircle} color="#6A9A7A" />
              )}
              {report.risks?.length > 0 && (
                <Section title="RISK_AREAS" items={report.risks} icon={AlertTriangle} color="#A06A6A" />
              )}
            </div>

            <div className="flex items-center gap-2 mt-4">
              <RefreshCw className="w-3 h-3 text-[#9A8678]/30" strokeWidth={1.5} />
              <span className="font-mono text-[9px] text-[#9A8678]/30">Report generated using live GitHub data + {groqKey ? 'Groq (LLaMA 3.3 70B)' : 'Gemini 1.5 Flash'}</span>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
