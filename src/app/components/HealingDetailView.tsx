import { motion } from 'motion/react';
import { Play, Square, Shield, Zap } from 'lucide-react';
import { SystemGraph } from './SystemGraph';
import { CIHealthPanel } from './CIHealthPanel';
import { HealingProgressPanel } from './HealingProgressPanel';
import { SystemStatus, Project } from '../types';
import type { HealingRun } from '../lib/healingRun';

interface HealingDetailViewProps {
  project: Project;
  systemStatus: SystemStatus;
  activeNode: string | undefined;
  run: HealingRun;
  effectivePat: string;
  safeMode: boolean;
  onToggleSafeMode: () => void;
  onBack: () => void;
  onHeal: () => void;
}

export function HealingDetailView({
  project, systemStatus, activeNode, run, effectivePat, safeMode, onToggleSafeMode, onBack, onHeal,
}: HealingDetailViewProps) {
  const hasRun = !!run.startedAt;
  // Re-scan CI whenever the heal reaches a milestone that changes CI state.
  const ciRefreshKey = `${run.prUrl ?? ''}|${run.verify ?? ''}|${run.outcome?.kind ?? ''}`;
  const isConnected = !!(project.owner && project.repoName);
  const isLive = isConnected && !!effectivePat;
  const missingPat = isConnected && !effectivePat;
  const patLabel = project.platform === 'gitlab' ? 'GITLAB_PAT' : 'GITHUB_PAT';
  const showCI = isLive && project.platform !== 'gitlab';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Sub-header: back button, project name, LIVE/DEMO badge, status */}
      <div className="px-8 py-4 border-b border-[#CAAA98]/15 bg-[#0a0e1a]/40 flex items-center justify-between flex-shrink-0">
        <button
          onClick={onBack}
          className="font-mono text-[10px] text-[#9A8678]/60 hover:text-[#CAAA98] transition-colors tracking-wider"
        >
          &lt; BACK_TO_REPOSITORIES
        </button>
        <div className="flex items-center gap-3">
          <div className="font-mono text-xs text-[#CAAA98] tracking-widest">
            {project.name.toUpperCase()}
          </div>
          {isLive ? (
            <div className="font-mono text-[9px] text-[#6A9A7A]/70 tracking-wider border border-[#6A9A7A]/30 px-2 py-0.5">LIVE</div>
          ) : (
            <div className="font-mono text-[9px] text-[#9A8678]/40 tracking-wider border border-[#9A8678]/20 px-2 py-0.5">DEMO</div>
          )}
          {/* Safe mode toggle */}
          <motion.button
            onClick={onToggleSafeMode}
            className="flex items-center gap-1.5 px-2 py-0.5 font-mono text-[9px] tracking-wider border transition-colors"
            style={safeMode
              ? { borderColor: '#D4A574', color: '#D4A574', backgroundColor: 'rgba(212,165,116,0.08)' }
              : { borderColor: '#9A8678', color: '#9A8678', opacity: 0.5 }
            }
            whileHover={{ opacity: 1 }}
            title={safeMode ? 'Safe Mode ON — analysis only, no commits' : 'Safe Mode OFF — fixes will be applied'}
          >
            {safeMode ? <Shield className="w-3 h-3" strokeWidth={1.5} /> : <Zap className="w-3 h-3" strokeWidth={1.5} />}
            {safeMode ? 'SAFE_MODE' : 'AUTO_APPLY'}
          </motion.button>
        </div>
        <div className="font-mono text-[9px] tracking-wider" style={{ color: systemStatus === 'healing' ? '#D4A574' : systemStatus === 'healthy' ? '#6A9A7A' : systemStatus === 'stopped' ? '#A06A6A' : '#9A8678' }}>
          {run.outcome ? run.outcome.kind.toUpperCase() : systemStatus.toUpperCase()}
        </div>
      </div>

      {/* Main area split: system graph on top, CI health panel below */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">

        {/* System graph + heal button */}
        <div className="relative p-6 overflow-hidden" style={hasRun ? { flex: '0 0 46%', minHeight: 300 } : { flex: showCI ? '1 1 0' : '1 1 auto' }}>
          <SystemGraph status={systemStatus} activeNode={activeNode} run={run} />

          {/* Warning shown when repo is real but PAT is missing */}
          {missingPat && (
            <div className="absolute top-4 left-0 right-0 flex justify-center pointer-events-none">
              <div className="font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-2 bg-[#0a0e1a]/80">
                Set {patLabel} in settings to enable live healing
              </div>
            </div>
          )}

          {/* Heal / Terminate button */}
          <div className="absolute bottom-8 left-0 right-0 flex justify-center">
            <motion.button
              onClick={onHeal}
              className="px-10 py-4 border-2 font-mono text-sm tracking-widest flex items-center gap-3 relative overflow-hidden"
              style={{
                borderColor: systemStatus === 'healing' ? '#A06A6A' : '#CAAA98',
                color: systemStatus === 'healing' ? '#A06A6A' : '#CAAA98',
                backgroundColor: 'rgba(10, 14, 26, 0.9)',
              }}
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              animate={{
                boxShadow: systemStatus === 'healing'
                  ? ['0 0 20px rgba(212,165,116,0.4)', '0 0 40px rgba(212,165,116,0.7)', '0 0 20px rgba(212,165,116,0.4)']
                  : '0 0 10px rgba(202,170,152,0.3)',
              }}
              transition={{ duration: 2, repeat: systemStatus === 'healing' ? Infinity : 0 }}
            >
              {systemStatus === 'idle' && (
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-[#CAAA98]/20 to-transparent"
                  animate={{ x: ['-100%', '200%'] }}
                  transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                />
              )}
              <span className="relative z-10 flex items-center gap-3">
                {systemStatus === 'healing'
                  ? <><Square className="w-4 h-4" strokeWidth={1.5} />[ TERMINATE ]</>
                  : <><Play className="w-4 h-4" strokeWidth={1.5} />[ INITIATE_HEALING_PROTOCOL ]</>
                }
              </span>
            </motion.button>
          </div>
        </div>

        {/* Live healing progress — phases, diagnosis, per-file diffs, PR + CI verdict */}
        {hasRun && (
          <div className="border-t border-[#CAAA98]/10 flex-1 min-h-0">
            <HealingProgressPanel run={run} />
          </div>
        )}

        {/* CI health panel — GitHub only, visible when live */}
        {showCI && (
          <div className="border-t border-[#CAAA98]/10 flex-shrink-0" style={{ height: hasRun ? '170px' : '240px' }}>
            <CIHealthPanel project={project} pat={effectivePat} refreshKey={ciRefreshKey} live={systemStatus === 'healing'} />
          </div>
        )}
      </div>
    </div>
  );
}
