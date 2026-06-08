import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle } from 'lucide-react';
import { BackgroundCanvas } from './BackgroundCanvas';
import { SettingsModal } from './SettingsModal';
import { TopBar } from './TopBar';
import { RepoListView } from './RepoListView';
import { HealingDetailView } from './HealingDetailView';
import { TerminalPanel } from './TerminalPanel';
import { IntelligenceStream } from './IntelligenceStream';
import { HistoryView } from './HistoryView';
import { IntelligenceView } from './IntelligenceView';
import { useHealingProcess } from '../hooks/useHealingProcess';
import { Project, View, MetricsData } from '../types';
import { getRepo, getComprehensiveCI } from '../lib/github';
import { getRepo as getGitlabRepo, getLatestFailedPipeline } from '../lib/gitlab';
import { apiGetRepos, apiAddRepo, apiUpdateRepo, apiDeleteRepo, apiGetMetrics, apiCreateEvent, apiGetEvents, apiUpdateEvent } from '../lib/backendApi';
import { levelToErrorType, type ErrorLevel } from '../lib/errorLevel';

interface DashboardProps {
  onLogout: () => void;
}

function detectPlatform(url: string): { platform: 'github' | 'gitlab'; owner: string; repo: string } | null {
  const cleaned = url.replace(/^https?:\/\//, '').replace(/\.git$/, '').trim();
  if (cleaned.startsWith('gitlab.com/')) {
    const parts = cleaned.replace('gitlab.com/', '').split('/').filter(Boolean);
    if (parts.length >= 2) return { platform: 'gitlab', owner: parts[0], repo: parts[1] };
  }
  const parts = cleaned.replace('github.com/', '').split('/').filter(Boolean);
  if (parts.length >= 2) return { platform: 'github', owner: parts[0], repo: parts[1] };
  return null;
}

// Confidence approval modal — shown when AI confidence is below threshold
function ApprovalModal({ approval, onApprove, onCancel }: {
  approval: { confidence: number; analysis: string; fixes: Array<{ path: string; explanation: string }>; alternatives: Array<{ description: string; confidence: number; risk: string }> };
  onApprove: () => void;
  onCancel: () => void;
}) {
  const confColor = approval.confidence >= 50 ? '#D4A574' : '#A06A6A';

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: 'rgba(10, 14, 26, 0.92)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <motion.div
        className="border border-[#D4A574]/30 bg-[#0a0e1a]/98 p-8 w-full max-w-lg mx-4"
        initial={{ scale: 0.95, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <div className="font-mono text-[10px] text-[#D4A574] tracking-widest mb-6">
          ⚠ LOW_CONFIDENCE_ALERT :: OPERATOR_APPROVAL_REQUIRED
        </div>

        {/* Confidence bar */}
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="font-mono text-[9px] text-[#9A8678]/60 tracking-widest">AI_CONFIDENCE_SCORE</span>
            <span className="font-mono text-sm" style={{ color: confColor }}>{approval.confidence}%</span>
          </div>
          <div className="h-1.5 bg-[#202940] overflow-hidden">
            <motion.div
              className="h-full"
              style={{ backgroundColor: confColor }}
              initial={{ width: 0 }}
              animate={{ width: `${approval.confidence}%` }}
              transition={{ duration: 0.6 }}
            />
          </div>
          <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1">
            Below 65% threshold — manual review recommended
          </div>
        </div>

        {/* Root cause */}
        <div className="mb-5">
          <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-2">DIAGNOSED_ROOT_CAUSE</div>
          <div className="font-mono text-[11px] text-[#CAAA98]/80 leading-relaxed border border-[#CAAA98]/10 bg-[#202940]/40 p-3">
            {approval.analysis}
          </div>
        </div>

        {/* Proposed fixes */}
        <div className="mb-5">
          <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-2">PROPOSED_CHANGES</div>
          <div className="space-y-1.5">
            {approval.fixes.map((f, i) => (
              <div key={i} className="font-mono text-[10px] text-[#CAAA98]/70 flex items-start gap-2">
                <span className="text-[#CAAA98]/30 flex-shrink-0">▸</span>
                <span><span className="text-[#D4A574]/70">{f.path}</span>: {f.explanation}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Alternatives */}
        {approval.alternatives.length > 0 && (
          <div className="mb-6">
            <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-2">ALTERNATIVE_STRATEGIES</div>
            <div className="space-y-1.5">
              {approval.alternatives.map((alt, i) => {
                const riskColor = alt.risk === 'low' ? '#6A9A7A' : alt.risk === 'medium' ? '#D4A574' : '#A06A6A';
                return (
                  <div key={i} className="flex items-center gap-2 font-mono text-[10px]">
                    <span className="text-[#9A8678]/40 w-7 flex-shrink-0">{alt.confidence}%</span>
                    <span className="text-[#9A8678]/70 flex-1 truncate">{alt.description}</span>
                    <span className="border px-1.5 py-0.5 text-[9px] flex-shrink-0" style={{ color: riskColor, borderColor: riskColor + '40' }}>
                      {alt.risk.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-4">
          <motion.button
            onClick={onApprove}
            className="flex-1 py-3 border font-mono text-xs tracking-widest flex items-center justify-center gap-2"
            style={{ borderColor: '#6A9A7A', color: '#6A9A7A' }}
            whileHover={{ backgroundColor: 'rgba(106, 154, 122, 0.1)' }}
            whileTap={{ scale: 0.98 }}
          >
            <CheckCircle className="w-4 h-4" strokeWidth={1.5} />
            APPROVE &amp; APPLY
          </motion.button>
          <motion.button
            onClick={onCancel}
            className="flex-1 py-3 border font-mono text-xs tracking-widest"
            style={{ borderColor: '#A06A6A40', color: '#A06A6A' }}
            whileHover={{ backgroundColor: 'rgba(160, 106, 106, 0.08)' }}
            whileTap={{ scale: 0.98 }}
          >
            CANCEL
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function Dashboard({ onLogout }: DashboardProps) {
  const [githubPat, setGithubPat] = useState(() => import.meta.env.VITE_GITHUB_PAT || sessionStorage.getItem('aegis_pat') || '');
  const [gitlabPat, setGitlabPat] = useState(() => import.meta.env.VITE_GITLAB_PAT || sessionStorage.getItem('aegis_gitlab_pat') || '');
  const [geminiKey, setGeminiKey] = useState(() => import.meta.env.VITE_GEMINI_KEY || sessionStorage.getItem('aegis_gemini') || '');
  const [groqKey, setGroqKey] = useState(() => import.meta.env.VITE_GROQ_KEY || sessionStorage.getItem('aegis_groq') || '');
  const [gcloudKey] = useState(() => import.meta.env.VITE_GCLOUD_KEY || '');

  const [view, setView] = useState<View>(() => (sessionStorage.getItem('aegis_view') as View) || 'healing');
  // loadMetrics is declared below — safe to reference here because handleViewChange
  // is only ever called on user click, never during the render phase (no TDZ risk).
  const handleViewChange = (v: View) => {
    sessionStorage.setItem('aegis_view', v);
    setView(v);
    if (v === 'intelligence') loadMetrics();
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  // Incrementing counter forces HistoryView to immediately re-fetch when an event is written
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const bumpHistory = useCallback(() => setHistoryRefreshKey(k => k + 1), []);

  // Tracks in-session CI scan events: projectId → healingEventId
  const ciEventRef = useRef<Record<string, number>>({});
  // Mirror of projects state for use inside setInterval without stale closure
  const projectsRef = useRef<Project[]>([]);

  const loadMetrics = useCallback(() => {
    apiGetMetrics()
      .then(data => { if (data) setMetrics(data); setMetricsLoading(false); })
      .catch(() => setMetricsLoading(false));
  }, []);

  // Scans a project's live CI status, updates the badge, and creates/resolves
  // healing events so changes appear in History and Intelligence automatically.
  const scanCIStatus = useCallback(async (project: Project) => {
    if (!project.owner || !project.repoName) return;

    const wasAlreadyFailing = project.errorType?.startsWith('FAILING:');
    const wasPendingScan = !project.errorType || project.errorType === 'PENDING_SCAN';
    const projectName = `${project.owner}/${project.repoName}`;

    try {
      let healingStatus: ErrorLevel;
      let errorType: string;

      if (project.platform === 'gitlab' && gitlabPat) {
        const failed = await getLatestFailedPipeline(gitlabPat, project.owner, project.repoName).catch(() => null);
        healingStatus = failed ? 'HIGH' : 'NO_ERROR';
        errorType = failed ? `FAILING: pipeline#${failed.id}` : 'CI_HEALTHY';
      } else if (project.platform !== 'gitlab' && githubPat) {
        const checks = await getComprehensiveCI(githubPat, project.owner, project.repoName, project.repo || 'main').catch(() => []);
        const failing = checks.filter(c => c.conclusion === 'failure');
        healingStatus = failing.length > 0 ? 'HIGH' : 'NO_ERROR';
        errorType = failing.length > 0
          ? `FAILING: ${failing.slice(0, 2).map(c => c.name).join(', ')}`
          : checks.length > 0 ? 'CI_HEALTHY' : 'PENDING_SCAN';
      } else {
        return;
      }

      apiUpdateRepo(project.id, { healingStatus, errorType }).catch(() => {});
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, healingStatus, errorType } : p));

      // ── Event tracking ────────────────────────────────────────────────────────

      // New failure detected — create a 'healing' event so it shows in History
      if (!wasAlreadyFailing && errorType.startsWith('FAILING:')) {
        const ev = await apiCreateEvent({
          pipeline_id: `ci-${project.id}-${Date.now()}`,
          project_name: projectName,
          branch: project.repo || 'main',
          provider: project.platform || 'github',
          failed_stage: errorType.replace('FAILING: ', ''),
          status: 'healing',
        }).catch(() => null);
        if (ev) { ciEventRef.current[project.id] = ev.id; loadMetrics(); bumpHistory(); }
      }

      // Failure resolved — update the tracked healing event to 'healed'
      if (wasAlreadyFailing && errorType === 'CI_HEALTHY') {
        const storedId = ciEventRef.current[project.id];
        if (storedId) {
          // In-session tracking: we know exactly which event to close
          apiUpdateEvent(storedId, { status: 'healed' }).catch(() => {});
          delete ciEventRef.current[project.id];
        } else {
          // Cross-session: find the latest open healing event for this project
          const events = await apiGetEvents(project.repoName)
            .catch(() => []) as Array<{ id: number; status: string; project_name: string }>;
          const open = events.find(e => e.status === 'healing' && e.project_name === projectName);
          if (open) apiUpdateEvent(open.id, { status: 'healed' }).catch(() => {});
        }
        loadMetrics();
        bumpHistory();
      }

      // First scan completed and CI is already healthy — record a baseline 'healed' event
      if (wasPendingScan && errorType === 'CI_HEALTHY') {
        apiCreateEvent({
          pipeline_id: `ci-baseline-${project.id}-${Date.now()}`,
          project_name: projectName,
          branch: project.repo || 'main',
          provider: project.platform || 'github',
          status: 'healed',
        }).catch(() => {});
        loadMetrics();
      }

    } catch { /* non-fatal — card stays at current state */ }
  }, [githubPat, gitlabPat, loadMetrics]);

  useEffect(() => {
    apiGetRepos()
      .then(repos => {
        setProjects(repos);
        const stored = sessionStorage.getItem('aegis_selected');
        if (stored && !repos.find((r: { id: string }) => r.id === stored)) {
          sessionStorage.removeItem('aegis_selected');
          setSelectedProject(null);
        }
        // Background-scan all connected repos on load so stale FAILING/PENDING_SCAN
        // badges update immediately rather than waiting for the 2-minute interval.
        (repos as Project[]).filter(r => r.owner && r.repoName).forEach(r => scanCIStatus(r));
      })
      .catch((err: Error) => {
        if (err.message === 'SESSION_EXPIRED') onLogout();
      });
    loadMetrics();
  }, [onLogout, loadMetrics, scanCIStatus]);

  // Keep projectsRef current so the polling interval below never reads stale state
  useEffect(() => { projectsRef.current = projects; }, [projects]);

  // Periodic re-scan every 30 s — keeps badges in sync with GitHub without waiting 2 min
  const anyPatSet = !!(githubPat || gitlabPat);
  useEffect(() => {
    if (!anyPatSet) return;
    const handle = setInterval(() => {
      projectsRef.current.forEach(p => scanCIStatus(p));
    }, 30 * 1000);
    return () => clearInterval(handle);
  }, [anyPatSet, scanCIStatus]);

  // Re-scan all repos when the user returns to this tab (e.g. after pushing a fix on GitHub)
  useEffect(() => {
    if (!anyPatSet) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        projectsRef.current.filter(r => r.owner && r.repoName).forEach(r => scanCIStatus(r));
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [anyPatSet, scanCIStatus]);

  // Keep Intelligence metrics fresh — poll every 10 s regardless of active tab
  useEffect(() => {
    const handle = setInterval(() => { loadMetrics(); }, 10_000);
    return () => clearInterval(handle);
  }, [loadMetrics]);

  const [selectedProject, setSelectedProject] = useState<string | null>(() => sessionStorage.getItem('aegis_selected'));
  const selectProject = (id: string) => {
    sessionStorage.setItem('aegis_selected', id);
    setSelectedProject(id);
    // Immediately rescan the selected repo so its badge is always fresh on open
    const proj = projectsRef.current.find(p => p.id === id);
    if (proj) scanCIStatus(proj);
  };
  const unselectProject = () => { sessionStorage.removeItem('aegis_selected'); setSelectedProject(null); };

  const [showAddRepo, setShowAddRepo] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  const [addingRepo, setAddingRepo] = useState(false);
  const [addRepoError, setAddRepoError] = useState('');

  const [showSettings, setShowSettings] = useState(false);
  const [settingsKey, setSettingsKey] = useState(0);
  const [safeMode, setSafeMode] = useState(false);

  // Called by useHealingProcess whenever a backend event is written (healed/failed)
  const handleEventUpdated = useCallback(() => {
    loadMetrics();
    bumpHistory();
  }, [loadMetrics, bumpHistory]);

  const handleHealingComplete = useCallback((id: string, status: 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_ERROR') => {
    const errorType = levelToErrorType(status as ErrorLevel);
    apiUpdateRepo(id, { healingStatus: status, errorType }).catch(() => {});
    setProjects(prev => prev.map(p => p.id === id ? { ...p, healingStatus: status, errorType } : p));
    loadMetrics();
    bumpHistory();
  }, [loadMetrics, bumpHistory]);

  const {
    systemStatus, activeNode, streamEntries, logs, showLogs, setShowLogs,
    healRepo, resetHealing, pendingApproval, approveHealing, cancelHealing,
  } = useHealingProcess({
    projects, selectedProject, githubPat, gitlabPat, geminiKey, groqKey, gcloudKey,
    safeMode,
    onHealingComplete: handleHealingComplete,
    onEventUpdated: handleEventUpdated,
  });

  const openSettings = () => { setSettingsKey(k => k + 1); setShowSettings(true); };

  const handleSaveSettings = (pat: string, gitlab: string, gemini: string, groq: string) => {
    setGithubPat(pat); setGitlabPat(gitlab); setGeminiKey(gemini); setGroqKey(groq);
    if (pat) sessionStorage.setItem('aegis_pat', pat); else sessionStorage.removeItem('aegis_pat');
    if (gitlab) sessionStorage.setItem('aegis_gitlab_pat', gitlab); else sessionStorage.removeItem('aegis_gitlab_pat');
    if (gemini) sessionStorage.setItem('aegis_gemini', gemini); else sessionStorage.removeItem('aegis_gemini');
    if (groq) sessionStorage.setItem('aegis_groq', groq); else sessionStorage.removeItem('aegis_groq');
  };

  const handleAddRepo = async (urlOverride?: string) => {
    const url = (urlOverride ?? newRepoUrl).trim();
    if (!url) return;
    setAddRepoError('');
    const inHealingTab = !urlOverride;
    if (inHealingTab) setAddingRepo(true);
    try {
      const parsed = detectPlatform(url);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let saved: any;
      if (parsed) {
        const { platform, owner, repo } = parsed;
        const pat = platform === 'gitlab' ? gitlabPat : githubPat;
        const baseUrl = `https://${platform === 'gitlab' ? 'gitlab' : 'github'}.com/${owner}/${repo}`;
        if (pat) {
          try {
            const info = platform === 'gitlab'
              ? await getGitlabRepo(pat, owner, repo)
              : await getRepo(pat, owner, repo);
            const projectData = {
              name: info.repo, errorType: 'PENDING_SCAN', repo: info.defaultBranch,
              severity: 'medium' as const, owner: info.owner, repoName: info.repo, platform,
              githubUrl: `https://${platform === 'gitlab' ? 'gitlab' : 'github'}.com/${info.fullName}`,
              stars: info.stars, forks: info.forks, language: info.language,
              openIssues: info.openIssues, description: info.description,
            };
            saved = await apiAddRepo(projectData);
          } catch (githubErr) {
            // GitHub/GitLab fetch failed — save anyway without metadata
            console.warn('[AEGIS] repo fetch failed, saving as UNVALIDATED:', githubErr);
            const projectData = { name: repo, errorType: 'UNVALIDATED', repo: 'main', severity: 'medium' as const, owner, repoName: repo, platform, githubUrl: baseUrl };
            saved = await apiAddRepo(projectData);
          }
        } else {
          const projectData = { name: repo, errorType: 'PENDING_SCAN', repo: 'main', severity: 'medium' as const, owner, repoName: repo, platform, githubUrl: baseUrl };
          saved = await apiAddRepo(projectData);
        }
      } else {
        const name = url.includes('/')
          ? url.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') ?? url
          : url;
        const projectData = { name, errorType: 'PENDING_SCAN', repo: 'main', severity: 'medium' as const, githubUrl: url.startsWith('http') ? url : `https://github.com/${url}` };
        saved = await apiAddRepo(projectData);
      }
      // Success — add to list and close the form, then scan CI in background
      setProjects(prev => [...prev, saved as Project]);
      if (inHealingTab) { setNewRepoUrl(''); setShowAddRepo(false); }
      scanCIStatus(saved as Project);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save repository — is the backend running?';
      console.error('[AEGIS] handleAddRepo error:', msg, e);
      setAddRepoError(msg);
      // Keep the form open so the user can read the error
    } finally {
      if (inHealingTab) setAddingRepo(false);
    }
  };


  const handleRemoveRepo = (id: string) => {
    apiDeleteRepo(id).catch(() => {});
    setProjects(prev => prev.filter(p => p.id !== id));
    if (selectedProject === id) { unselectProject(); resetHealing(); }
  };

  const handleSetCategory = (id: string, category: string) => {
    apiUpdateRepo(id, { category }).catch(() => {});
    setProjects(prev => prev.map(p => p.id === id ? { ...p, category } : p));
  };

  const handleBack = () => { unselectProject(); resetHealing(); };

  const selectedProjectData = projects.find(p => p.id === selectedProject);
  const effectivePat = selectedProjectData?.platform === 'gitlab' ? gitlabPat : githubPat;

  return (
    <div className="w-full h-screen overflow-hidden flex flex-col" style={{ background: 'linear-gradient(135deg, #0a0e1a 0%, #202940 100%)' }}>
      <BackgroundCanvas />

      <SettingsModal
        key={settingsKey}
        show={showSettings}
        onClose={() => setShowSettings(false)}
        currentPat={githubPat}
        currentGitlabPat={gitlabPat}
        currentGeminiKey={geminiKey}
        currentGroqKey={groqKey}
        onSave={handleSaveSettings}
      />

      {/* Confidence-based approval modal */}
      <AnimatePresence>
        {pendingApproval && (
          <ApprovalModal
            approval={pendingApproval}
            onApprove={approveHealing}
            onCancel={cancelHealing}
          />
        )}
      </AnimatePresence>

      <TopBar
        systemStatus={systemStatus}
        view={view}
        onViewChange={handleViewChange}
        anyPatSet={anyPatSet}
        onOpenSettings={openSettings}
        onLogout={onLogout}
      />

      <div className="relative z-10 flex-1 flex overflow-hidden">

        {view === 'healing' && (
          <>
            <div className="flex-1 flex flex-col overflow-hidden">
              {!selectedProject && (
                <RepoListView
                  projects={projects}
                  showAddRepo={showAddRepo}
                  newRepoUrl={newRepoUrl}
                  addingRepo={addingRepo}
                  addRepoError={addRepoError}
                  anyPatSet={anyPatSet}
                  onToggleAddRepo={() => setShowAddRepo(v => !v)}
                  onNewRepoUrlChange={setNewRepoUrl}
                  onAddRepo={handleAddRepo}
                  onSelectProject={selectProject}
                  onRemoveProject={handleRemoveRepo}
                  onSetCategory={handleSetCategory}
                />
              )}
              {selectedProject && selectedProjectData && (
                <HealingDetailView
                  project={selectedProjectData}
                  systemStatus={systemStatus}
                  activeNode={activeNode}
                  effectivePat={effectivePat}
                  safeMode={safeMode}
                  onToggleSafeMode={() => setSafeMode(v => !v)}
                  onBack={handleBack}
                  onHeal={healRepo}
                />
              )}
            </div>
            {selectedProject && (
              <motion.div
                className="w-[420px] border-l border-[#CAAA98]/10 flex-shrink-0"
                initial={{ x: 420, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.4 }}
              >
                <IntelligenceStream entries={streamEntries} />
              </motion.div>
            )}
          </>
        )}

        {view === 'history' && (
          <HistoryView groqKey={groqKey} refreshKey={historyRefreshKey} />
        )}

        {view === 'intelligence' && (
          <IntelligenceView metrics={metrics} loading={metricsLoading} />
        )}

      </div>

      {view === 'healing' && selectedProject && (
        <TerminalPanel
          logs={logs}
          showLogs={showLogs}
          onToggle={() => setShowLogs(v => !v)}
        />
      )}
    </div>
  );
}
