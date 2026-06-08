import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, ReferenceLine,
} from 'recharts';
import { Loader2, TrendingUp, Clock, Target, CheckCircle, ChevronDown, ChevronRight, AlertTriangle, Radio } from 'lucide-react';
import { MetricsData, HealingEventRecord } from '../types';

interface IntelligenceViewProps {
  metrics: MetricsData | null;
  loading: boolean;
}

function mttrDisplay(ms: number): string {
  if (ms === 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function DarkTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="border border-[#CAAA98]/20 bg-[#0a0e1a]/95 px-3 py-2 font-mono">
      {label && <div className="text-[9px] text-[#9A8678]/60 mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="text-[10px]" style={{ color: p.color }}>{p.name}: {p.value}</div>
      ))}
    </div>
  );
}

function HealthRing({ value }: { value: number }) {
  const radius = 58;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  const color = value >= 70 ? '#6A9A7A' : value >= 40 ? '#D4A574' : '#A06A6A';

  return (
    <div className="flex flex-col items-center justify-center">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r="72" fill="none" stroke="#CAAA98" strokeWidth="0.5" strokeOpacity="0.1" />
        <circle cx="80" cy="80" r={radius} fill="none" stroke="#202940" strokeWidth="10" />
        <motion.circle
          cx="80" cy="80" r={radius}
          fill="none" stroke={color} strokeWidth="10" strokeLinecap="butt"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.2, ease: 'easeOut' }}
          transform="rotate(-90 80 80)"
        />
        <text x="80" y="72" textAnchor="middle" fill={color} fontFamily="monospace" fontSize="26" fontWeight="bold">
          {value}%
        </text>
        <text x="80" y="88" textAnchor="middle" fill="#9A8678" fontFamily="monospace" fontSize="9" opacity="0.7">
          HEALTH_SCORE
        </text>
        {Array.from({ length: 12 }).map((_, i) => {
          const angle = (i / 12) * 360 - 90;
          const rad = (angle * Math.PI) / 180;
          return (
            <line
              key={i}
              x1={80 + 65 * Math.cos(rad)} y1={80 + 65 * Math.sin(rad)}
              x2={80 + 70 * Math.cos(rad)} y2={80 + 70 * Math.sin(rad)}
              stroke="#CAAA98" strokeWidth="0.5" strokeOpacity="0.2"
            />
          );
        })}
      </svg>
      <div className="font-mono text-[9px] text-[#9A8678]/40 tracking-widest mt-1">
        {value >= 70 ? 'SYSTEM_STABLE' : value >= 40 ? 'ATTENTION_REQUIRED' : 'CRITICAL_STATE'}
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, icon: Icon, color = '#CAAA98' }: {
  label: string; value: string; sub?: string; icon: React.ElementType; color?: string;
}) {
  return (
    <motion.div
      className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4"
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-3.5 h-3.5" style={{ color }} strokeWidth={1.5} />
        <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest">{label}</div>
      </div>
      <div className="font-mono text-2xl" style={{ color }}>{value}</div>
      {sub && <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1">{sub}</div>}
    </motion.div>
  );
}

// Expandable row showing event detail: root_cause + fix_steps
function RecentEventRow({ event }: { event: HealingEventRecord }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = event.status === 'healed' ? '#6A9A7A' : event.status === 'failed' ? '#A06A6A' : '#D4A574';
  const hasDetail = !!(event.root_cause || (event.fix_steps?.length ?? 0) > 0 || event.failed_stage);

  return (
    <div className="border-b border-[#CAAA98]/5 last:border-0">
      <button
        onClick={() => hasDetail && setExpanded(v => !v)}
        className={`w-full flex items-center gap-3 py-2.5 text-left transition-colors ${hasDetail ? 'hover:bg-[#CAAA98]/3 cursor-pointer' : 'cursor-default'}`}
      >
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor }} />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] text-[#CAAA98]/80 truncate">{event.project_name}</div>
          <div className="font-mono text-[9px] text-[#9A8678]/40">
            {event.branch} · {event.provider}
            {event.failed_stage && <span className="text-[#A06A6A]/50"> · {event.failed_stage}</span>}
          </div>
        </div>
        {event.confidence != null && (
          <div className="font-mono text-[9px] flex-shrink-0" style={{ color: event.confidence >= 65 ? '#6A9A7A' : '#D4A574' }}>
            {event.confidence}%
          </div>
        )}
        {hasDetail && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-[#9A8678]/30 flex-shrink-0" strokeWidth={1.5} />
            : <ChevronRight className="w-3 h-3 text-[#9A8678]/30 flex-shrink-0" strokeWidth={1.5} />
        )}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="pl-5 pr-3 pb-3 space-y-2 bg-[#0a0e1a]/30">
              {event.root_cause && (
                <div>
                  <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest mb-1">ROOT_CAUSE</div>
                  <div className="font-mono text-[9px] text-[#CAAA98]/60 leading-relaxed">{event.root_cause}</div>
                </div>
              )}
              {event.fix_steps && event.fix_steps.length > 0 && (
                <div>
                  <div className="font-mono text-[8px] text-[#6A9A7A]/50 tracking-widest mb-1">
                    {event.status === 'healed' ? 'FIX_APPLIED' : 'PROPOSED_FIX'}
                  </div>
                  {event.fix_steps.map((step, i) => (
                    <div key={i} className="flex items-start gap-1.5 font-mono text-[9px] text-[#6A9A7A]/60 mb-0.5 leading-relaxed">
                      <span className="flex-shrink-0 text-[#6A9A7A]/40">▸</span>
                      <span>{step}</span>
                    </div>
                  ))}
                </div>
              )}
              {!event.root_cause && !event.fix_steps?.length && (
                <div className="font-mono text-[9px] text-[#9A8678]/30">No diagnosis available — run healing to get AI analysis</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Unresolved error row with expand to show root_cause
function UnresolvedErrorRow({ event }: { event: HealingEventRecord }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!(event.root_cause || event.failed_stage);

  return (
    <div className="border-b border-[#A06A6A]/8 last:border-0 py-2">
      <button
        onClick={() => hasDetail && setExpanded(v => !v)}
        className={`w-full flex items-start gap-2 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-[#A06A6A]/60 flex-shrink-0 mt-1.5" />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[10px] text-[#CAAA98]/70 truncate">{event.project_name}</div>
          {event.failed_stage && (
            <div className="font-mono text-[9px] text-[#A06A6A]/50 mt-0.5">✗ {event.failed_stage}</div>
          )}
        </div>
        {hasDetail && (
          expanded
            ? <ChevronDown className="w-3 h-3 text-[#9A8678]/30 flex-shrink-0 mt-1" strokeWidth={1.5} />
            : <ChevronRight className="w-3 h-3 text-[#9A8678]/30 flex-shrink-0 mt-1" strokeWidth={1.5} />
        )}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="pl-3.5 mt-1.5 pb-1 space-y-1.5">
              {event.root_cause ? (
                <>
                  <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-widest">ROOT_CAUSE</div>
                  <div className="font-mono text-[9px] text-[#CAAA98]/60 leading-relaxed">{event.root_cause}</div>
                </>
              ) : (
                <div className="font-mono text-[9px] text-[#9A8678]/30">Run healing to get AI diagnosis and auto-fix</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function IntelligenceView({ metrics, loading }: IntelligenceViewProps) {
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  useEffect(() => {
    if (metrics) setLastRefreshed(new Date());
  }, [metrics]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-[#9A8678]/40 animate-spin" strokeWidth={1.5} />
        <span className="font-mono text-xs text-[#9A8678]/40 ml-3 tracking-widest">LOADING_INTELLIGENCE...</span>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="font-mono text-xs text-[#9A8678]/40 tracking-widest">NO_DATA_AVAILABLE</div>
          <div className="font-mono text-[10px] text-[#9A8678]/30 mt-2">Run a healing session to populate metrics</div>
        </div>
      </div>
    );
  }

  const statusBarData = [
    { name: 'Healed',  value: metrics.healed,  fill: '#6A9A7A' },
    { name: 'Failed',  value: metrics.failed,  fill: '#A06A6A' },
    { name: 'Active',  value: metrics.healing, fill: '#D4A574' },
  ];

  const confidenceTrend = [...metrics.recent]
    .filter(e => e.confidence != null)
    .reverse()
    .map((e, i) => ({
      name: `#${i + 1}`,
      confidence: Math.round(e.confidence!),
      status: e.status,
    }));

  const providerData = Object.entries(metrics.by_provider).map(([name, value]) => ({
    name: name.toUpperCase(),
    value,
    fill: name === 'github' ? '#CAAA98' : '#9A8A7A',
  }));

  const severityOrder = ['critical', 'high', 'medium', 'low'];
  const severityColors: Record<string, string> = { critical: '#A06A6A', high: '#D4A574', medium: '#CAAA98', low: '#6A9A7A' };
  const severityData = severityOrder
    .filter(s => metrics.by_severity[s] != null)
    .map(s => ({ name: s.toUpperCase(), value: metrics.by_severity[s], fill: severityColors[s] }));

  const axisStyle = { fontFamily: 'monospace', fontSize: 9, fill: '#9A8678', opacity: 0.6 };

  // Unresolved = failed events from recent history
  const unresolvedEvents = metrics.recent.filter(e => e.status === 'failed');

  // Per-project solved vs remaining — uses all-time data from backend, not just recent 10
  const resolutionData = Object.entries(metrics.by_project ?? {})
    .filter(([, v]) => v.healed + v.failed > 0)
    .map(([name, v]) => ({ name, healed: v.healed, failed: v.failed }))
    .sort((a, b) => b.failed - a.failed)
    .slice(0, 6);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-8 py-4 border-b border-[#CAAA98]/15 bg-[#0a0e1a]/40 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="font-mono text-xs text-[#CAAA98] tracking-widest">INTELLIGENCE_DASHBOARD</div>
          <div className="flex items-center gap-1">
            <Radio size={8} className="text-[#6A9A7A] animate-pulse" />
            <span className="font-mono text-[8px] text-[#6A9A7A] tracking-widest">LIVE</span>
          </div>
        </div>
        <div className="font-mono text-[9px] text-[#9A8678]/40 mt-0.5">
          real-time healing metrics · auto-refreshes every 10s
          {lastRefreshed && ` · synced ${lastRefreshed.toLocaleTimeString()}`}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        <div className="max-w-5xl space-y-6">

          {/* Row 1: health ring + metric cards */}
          <div className="grid grid-cols-[180px_1fr] gap-6">
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4 flex items-center justify-center">
              <HealthRing value={metrics.success_rate} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                label="TOTAL_EVENTS" value={String(metrics.total)}
                sub={`${metrics.healed} healed · ${metrics.failed} failed · ${metrics.healing} active`}
                icon={TrendingUp} color="#CAAA98"
              />
              <MetricCard
                label="SUCCESS_RATE" value={`${metrics.success_rate}%`}
                sub="healed / (healed + failed)"
                icon={CheckCircle}
                color={metrics.success_rate >= 70 ? '#6A9A7A' : metrics.success_rate >= 40 ? '#D4A574' : '#A06A6A'}
              />
              <MetricCard
                label="MEAN_TIME_TO_RECOVER" value={mttrDisplay(metrics.avg_recovery_ms)}
                sub="avg across healed events"
                icon={Clock} color="#6A9A7A"
              />
              <MetricCard
                label="AVG_AI_CONFIDENCE"
                value={metrics.avg_confidence != null ? `${Math.round(metrics.avg_confidence)}%` : '—'}
                sub={metrics.avg_confidence != null
                  ? (metrics.avg_confidence >= 99 ? 'rule-based · 100% confidence' : metrics.avg_confidence >= 65 ? 'above approval threshold' : 'below approval threshold')
                  : 'no data yet'}
                icon={Target}
                color={metrics.avg_confidence != null
                  ? (metrics.avg_confidence >= 65 ? '#6A9A7A' : '#D4A574')
                  : '#9A8678'}
              />
            </div>
          </div>

          {/* Row 2: Unresolved errors panel */}
          {unresolvedEvents.length > 0 && (
            <div className="border border-[#A06A6A]/20 bg-[#0a0e1a]/60 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-3.5 h-3.5 text-[#A06A6A]/60" strokeWidth={1.5} />
                <div className="font-mono text-[9px] text-[#A06A6A]/60 tracking-widest">
                  UNRESOLVED_ERRORS
                </div>
                <div className="font-mono text-[9px] text-[#A06A6A]/30 ml-1">
                  {unresolvedEvents.length} unhealed
                </div>
              </div>
              <div className="text-[8px] font-mono text-[#9A8678]/30 mb-3 tracking-wider">
                Errors that were detected but could not be auto-fixed — click to see root cause
              </div>
              {unresolvedEvents.slice(0, 6).map(event => (
                <UnresolvedErrorRow key={event.id} event={event} />
              ))}
            </div>
          )}

          {/* Row 3: Errors solved vs remaining per project */}
          {resolutionData.length > 0 && (
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
              <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-4">
                ERRORS_SOLVED_VS_REMAINING <span className="text-[#9A8678]/30 ml-2">by project</span>
              </div>
              <ResponsiveContainer width="100%" height={Math.max(80, resolutionData.length * 32)}>
                <BarChart data={resolutionData} layout="vertical" barCategoryGap="25%" barGap={3}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#CAAA98" strokeOpacity={0.06} horizontal={false} />
                  <XAxis type="number" tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" tick={axisStyle} axisLine={false} tickLine={false} width={80} />
                  <Tooltip content={<DarkTooltip />} cursor={{ fill: '#CAAA98', fillOpacity: 0.04 }} />
                  <Bar dataKey="healed" name="Healed" fill="#6A9A7A" radius={[0, 2, 2, 0]} />
                  <Bar dataKey="failed" name="Remaining" fill="#A06A6A" radius={[0, 2, 2, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2 bg-[#6A9A7A] rounded-sm" />
                  <span className="font-mono text-[8px] text-[#9A8678]/50">Healed</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-2 bg-[#A06A6A] rounded-sm" />
                  <span className="font-mono text-[8px] text-[#9A8678]/50">Remaining / Failed</span>
                </div>
              </div>
            </div>
          )}

          {/* Row 4: Healing Outcome BarChart */}
          <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
            <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-4">HEALING_OUTCOME_DISTRIBUTION</div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={statusBarData} barCategoryGap="30%">
                <CartesianGrid strokeDasharray="3 3" stroke="#CAAA98" strokeOpacity={0.06} vertical={false} />
                <XAxis dataKey="name" tick={axisStyle} axisLine={false} tickLine={false} />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<DarkTooltip />} cursor={{ fill: '#CAAA98', fillOpacity: 0.04 }} />
                <Bar dataKey="value" name="Count" radius={[2, 2, 0, 0]}>
                  {statusBarData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Row 5: Confidence Trend AreaChart */}
          {confidenceTrend.length > 0 && (
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
              <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-4">
                AI_CONFIDENCE_TREND <span className="text-[#9A8678]/30 ml-2">last {confidenceTrend.length} events</span>
              </div>
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={confidenceTrend}>
                  <defs>
                    <linearGradient id="confGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6A9A7A" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#6A9A7A" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#CAAA98" strokeOpacity={0.06} vertical={false} />
                  <XAxis dataKey="name" tick={axisStyle} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={axisStyle} axisLine={false} tickLine={false} />
                  <Tooltip content={<DarkTooltip />} cursor={{ stroke: '#CAAA98', strokeOpacity: 0.2 }} />
                  <ReferenceLine y={65} stroke="#D4A574" strokeDasharray="4 4" strokeOpacity={0.4} />
                  <Area
                    type="monotone" dataKey="confidence" name="Confidence %"
                    stroke="#6A9A7A" strokeWidth={1.5}
                    fill="url(#confGrad)"
                    dot={{ fill: '#6A9A7A', r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#CAAA98', strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-1.5 mt-2">
                <div className="w-6 h-px border-t border-dashed border-[#D4A574]/50" />
                <span className="font-mono text-[8px] text-[#D4A574]/50">65% APPROVAL THRESHOLD</span>
              </div>
            </div>
          )}

          {/* Row 6: Provider + Severity BarCharts side by side */}
          <div className="grid grid-cols-2 gap-6">
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
              <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-4">BY_PROVIDER</div>
              {providerData.length === 0
                ? <div className="font-mono text-[10px] text-[#9A8678]/30 py-4 text-center">No data</div>
                : (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={providerData} layout="vertical" barCategoryGap="25%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#CAAA98" strokeOpacity={0.06} horizontal={false} />
                      <XAxis type="number" tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={axisStyle} axisLine={false} tickLine={false} width={50} />
                      <Tooltip content={<DarkTooltip />} cursor={{ fill: '#CAAA98', fillOpacity: 0.04 }} />
                      <Bar dataKey="value" name="Events" radius={[0, 2, 2, 0]}>
                        {providerData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
            </div>

            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
              <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-4">BY_SEVERITY</div>
              {severityData.length === 0
                ? <div className="font-mono text-[10px] text-[#9A8678]/30 py-4 text-center">No data</div>
                : (
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={severityData} layout="vertical" barCategoryGap="25%">
                      <CartesianGrid strokeDasharray="3 3" stroke="#CAAA98" strokeOpacity={0.06} horizontal={false} />
                      <XAxis type="number" tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={axisStyle} axisLine={false} tickLine={false} width={60} />
                      <Tooltip content={<DarkTooltip />} cursor={{ fill: '#CAAA98', fillOpacity: 0.04 }} />
                      <Bar dataKey="value" name="Events" radius={[0, 2, 2, 0]}>
                        {severityData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
            </div>
          </div>

          {/* Row 7: Recent events — expandable with root_cause + fix_steps */}
          {metrics.recent.length > 0 && (
            <div className="border border-[#CAAA98]/15 bg-[#0a0e1a]/60 p-4">
              <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest mb-1">RECENT_EVENTS</div>
              <div className="font-mono text-[8px] text-[#9A8678]/30 mb-3">Click any event to see root cause and fix details</div>
              {metrics.recent.slice(0, 8).map(event => (
                <RecentEventRow key={event.id} event={event} />
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
