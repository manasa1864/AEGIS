import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, SecurityAlert } from '../types';
import { getDependabotAlerts, getSecretScanningAlerts, getCodeScanningAlerts } from '../lib/security';

interface SecurityPageProps {
  projects: Project[];
  selectedProject: string | null;
  onSelectProject: (id: string) => void;
  onClearProject: () => void;
  githubPat: string;
  onAddRepo?: (url: string) => Promise<void>;
}

function severityColor(s: string): string {
  if (s === 'critical') return '#A06A6A';
  if (s === 'high') return '#C07060';
  if (s === 'medium') return '#D4A574';
  return '#9A8678';
}

function AlertSection({ title, alerts, loading }: { title: string; alerts: SecurityAlert[]; loading: boolean }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-3">
        <div className="font-mono text-[10px] text-[#9A8678] tracking-widest">{title}</div>
        {!loading && (
          <div className={`font-mono text-[9px] px-2 py-0.5 border ${alerts.length === 0 ? 'border-[#6A9A7A]/30 text-[#6A9A7A]' : 'border-[#A06A6A]/30 text-[#A06A6A]'}`}>
            {alerts.length === 0 ? 'CLEAN' : `${alerts.length} OPEN`}
          </div>
        )}
      </div>

      {loading && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}

      {!loading && alerts.length === 0 && (
        <div className="flex items-center gap-2 font-mono text-[10px] text-[#6A9A7A]/60">
          <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
          No open alerts
        </div>
      )}

      {alerts.length > 0 && (
        <div className="space-y-1.5">
          {alerts.map(alert => {
            const color = severityColor(alert.severity);
            return (
              <motion.div key={alert.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40 px-4 py-3 flex items-center gap-3"
              >
                <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0" style={{ color }} strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-[#CAAA98] truncate">{alert.description}</div>
                  {alert.package && <div className="font-mono text-[9px] text-[#9A8678]/40 mt-0.5">package: {alert.package}</div>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="font-mono text-[9px] border px-1.5 py-0.5" style={{ color, borderColor: `${color}50` }}>
                    {alert.severity.toUpperCase()}
                  </span>
                  {alert.url && (
                    <a href={alert.url} target="_blank" rel="noopener noreferrer"
                      className="font-mono text-[9px] text-[#9A8678]/40 border border-[#9A8678]/20 px-2 py-0.5 hover:border-[#9A8678]/40 hover:text-[#9A8678] transition-colors"
                    >VIEW</a>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SecurityPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, onAddRepo }: SecurityPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [dependabot, setDependabot] = useState<SecurityAlert[]>([]);
  const [secrets, setSecrets] = useState<SecurityAlert[]>([]);
  const [code, setCode] = useState<SecurityAlert[]>([]);
  const [loading, setLoading] = useState(false);

  const isGithub = (project?.platform ?? 'github') === 'github';

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !githubPat || !isGithub) return;
    setLoading(true);
    const [d, s, c] = await Promise.all([
      getDependabotAlerts(githubPat, project.owner, project.repoName),
      getSecretScanningAlerts(githubPat, project.owner, project.repoName),
      getCodeScanningAlerts(githubPat, project.owner, project.repoName),
    ]);
    setDependabot(d); setSecrets(s); setCode(c);
    setLoading(false);
  }, [project, githubPat, isGithub]);

  useEffect(() => { setDependabot([]); setSecrets([]); setCode([]); load(); }, [load]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);
  const total = dependabot.length + secrets.length + code.length;

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">SECURITY_WATCH</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
              {!loading && isConnected && (
                <div className={`font-mono text-[9px] px-2 py-0.5 border ${total === 0 ? 'border-[#6A9A7A]/30 text-[#6A9A7A]' : 'border-[#A06A6A]/30 text-[#A06A6A]'}`}>
                  {total === 0 ? 'ALL_CLEAR' : `${total} TOTAL ALERTS`}
                </div>
              )}
            </div>
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 border border-[#9A8678]/30 text-[#9A8678] font-mono text-[10px] px-3 py-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /> REFRESH
          </button>
        </div>

        {!isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">REPO_NOT_CONNECTED</div>}
        {!githubPat && isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">GITHUB_PAT not set — add it in settings</div>}
        {!isGithub && <div className="mb-4 font-mono text-[10px] text-[#9A8678]/50 border border-[#9A8678]/20 px-4 py-3">Security scanning via API is GitHub-only — use gitlab.com/&lt;owner&gt;/&lt;repo&gt;/-/security for GitLab</div>}

        {isGithub && isConnected && (
          <>
            <div className="mb-4 font-mono text-[9px] text-[#9A8678]/40 border border-[#9A8678]/10 px-3 py-2">
              Requires <span className="text-[#CAAA98]/60">security_events</span> scope on your GitHub PAT. 403 = missing scope, 404 = feature not enabled on repo.
            </div>
            <AlertSection title="DEPENDABOT_ALERTS" alerts={dependabot} loading={loading} />
            <AlertSection title="SECRET_SCANNING" alerts={secrets} loading={loading} />
            <AlertSection title="CODE_SCANNING" alerts={code} loading={loading} />
          </>
        )}
      </div>
    </div>
  );
}
