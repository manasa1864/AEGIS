import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, FileText, GitBranch, Clock, Cpu, Radio } from 'lucide-react';
import { HealingEventRecord } from '../types';
import { apiGetEvents, apiUpdateEvent } from '../lib/backendApi';
import { generatePostmortem } from '../lib/groq';

interface HistoryViewProps {
  groqKey: string;
  refreshKey?: number;
}

// Human-readable labels for every ErrorCategory
const CATEGORY_LABELS: Record<string, string> = {
  // syntax / workflow
  syntax_error: 'Syntax Error', yaml_error: 'YAML Error', missing_step: 'Missing Step',
  runner_label: 'Runner Label', cron_expression: 'Cron Expression',
  workflow_call_trigger: 'Workflow Call Trigger', multiline_script: 'Multiline Script',
  only_except_deprecated: 'GitLab only/except Deprecated',
  // environment
  env_var_missing: 'Missing Env Variable', secret_exposure: 'Secret Exposed',
  hardcoded_secret: 'Hardcoded Secret', deprecated_save_state: 'Deprecated save-state',
  missing_permissions: 'Missing Permissions', terraform_env: 'Terraform Env Vars',
  debug_flags: 'Debug Flags', gitlab_variable_masking: 'GitLab Variable Masking',
  env_missing: 'Missing Env Variable', permission_denied: 'Permission Denied',
  permissions_error: 'Permissions Error',
  // dependencies
  node_version: 'Node Version', npm_install_error: 'npm Install Error',
  husky_ci: 'Husky CI Hook', go_modules: 'Go Modules', rust_cargo: 'Rust Cargo',
  maven_wrapper: 'Maven/Gradle Wrapper', ruby_bundler: 'Ruby Bundler',
  yarn_berry: 'Yarn Berry', missing_dependency: 'Missing Dependency',
  python_deps: 'Python Deps', lockfile_corrupt: 'Lockfile Corrupt',
  venv_missing: 'Python Venv Missing',
  // build
  build_failure: 'Build Failure', node_heap_oom: 'Node Heap OOM',
  typescript_error: 'TypeScript Error', missing_build_script: 'Missing Build Script',
  webpack_build_failure: 'Webpack OOM / Build', vite_build_failure: 'Vite Build',
  dotnet_build_failure: '.NET / MSBuild', webpack_memory: 'Webpack Memory',
  esbuild_resolution: 'esbuild Resolution', makefile_ci: 'Makefile CI',
  compilation_failure: 'Compilation Error', memory_error: 'Memory / OOM',
  // git
  git_authentication: 'Git Auth', merge_conflict: 'Merge Conflict',
  submodule_error: 'Submodule', git_lfs: 'Git LFS',
  git_tag_failure: 'Git Tag / Semrel', git_credential_failure: 'Git Credentials',
  git_safe_directory: 'Git Safe Directory', git_tag_signing: 'Git Tag Signing',
  git_merge_conflict: 'Merge Conflict', git_push_rejected: 'Push Rejected',
  git_submodule_error: 'Submodule Error', git_lfs_error: 'Git LFS Error',
  invalid_branch: 'Invalid Branch',
  // pipeline
  timeout: 'Timeout', retry_policy: 'Retry Policy', fail_fast_matrix: 'Fail-Fast Matrix',
  artifact_failure: 'Artifact Failure', artifact_retention: 'Artifact Retention',
  missing_job_outputs: 'Missing Job Outputs', cache_failure: 'Cache Failure',
  gitlab_missing_cache: 'GitLab Cache Missing', matrix_failure: 'Matrix Job Cancelled',
  runner_unavailable: 'Runner Unavailable', concurrency_issue: 'Concurrency Cancelled',
  circular_dependency: 'Circular Dependency', job_timeout: 'Job Timeout',
  // config
  docker_config: 'Docker Config', eslint_config: 'ESLint Config',
  prettier_config: 'Prettier Config', editorconfig: 'EditorConfig',
  playwright_browser: 'Playwright Browsers', cypress_deps: 'Cypress Dependencies',
  lint_format_failure: 'Lint / Format', e2e_failure: 'E2E Test',
  yaml_syntax: 'YAML Syntax Error', actions_deprecation: 'Actions Deprecated',
  // auth / cloud
  oidc_failure: 'OIDC Auth', aws_auth_failure: 'AWS Auth', gcp_auth_failure: 'GCP Auth',
  secret_missing: 'Missing Secret', terraform_failure: 'Terraform',
  ssh_key_error: 'SSH Key Error', invalid_token: 'Invalid Token',
  // new build categories
  go_build_failure: 'Go Build', rust_build_failure: 'Rust / Cargo',
  husky_hook_failure: 'Husky Hook',
  // docker
  docker_auth: 'Docker Auth', docker_build: 'Docker Build', docker_pull: 'Docker Pull',
  docker_rate_limit: 'Docker Rate Limit', image_pull_failure: 'Image Pull Failure',
  container_health_failure: 'Container Health Failure',
  // advanced / test
  test_failure: 'Test Failure', coverage_failure: 'Coverage Failure',
  snapshot_mismatch: 'Snapshot Mismatch', flaky_test: 'Flaky Test',
  lint_failure: 'Lint Failure',
  // deployment
  deploy_failure: 'Deploy Failure', deployment_failure: 'Deployment Failure',
  service_unavailable: 'Service Unavailable',
  load_balancer_issue: 'Load Balancer', port_conflict: 'Port Conflict',
  // database — all 8 categories
  db_migration_error: 'DB Migration Error',
  db_connection_error: 'DB Connection Error',
  db_deadlock: 'DB Deadlock',
  db_schema_mismatch: 'DB Schema Mismatch',
  missing_db_index: 'Missing DB Index',
  transaction_rollback: 'Transaction Rollback',
  db_query_failure: 'DB Query Failure',
  db_replication_lag: 'DB Replication Lag',
  // legacy db keys (kept for backward compat with old events)
  database_migration: 'DB Migration Error', connection_pool: 'DB Connection Error',
  // api
  api_rate_limit: 'API Rate Limit', api_timeout: 'API Timeout',
  webhook_failure: 'Webhook Failure', cors_error: 'CORS Error',
  ssl_certificate: 'SSL Certificate', rest_endpoint_mismatch: 'REST Endpoint Mismatch',
  invalid_api_response: 'Invalid API Response', missing_file: 'Missing File',
  // external
  third_party_failure: 'Third-Party Service', schema_validation: 'Schema Validation',
  graphql_failure: 'GraphQL',
  // docker extended
  missing_docker_layer: 'Docker Layer Missing', dockerfile_syntax: 'Dockerfile Syntax',
  container_startup: 'Container Startup', registry_auth_failure: 'Registry Auth',
  volume_mount_failure: 'Volume Mount',
  // auth extended
  oauth_failure: 'OAuth Failure', secret_access_denied: 'Secret Access Denied',
  insufficient_role: 'Insufficient Role', cross_project_access: 'Cross-Project Access',
  // build tools
  gradle_build_failure: 'Gradle Build', maven_build_failure: 'Maven Build',
  artifact_missing: 'Artifact Missing',
  // runtime
  runtime_version_error: 'Runtime Version', null_reference: 'Null Reference',
  type_mismatch: 'Type Mismatch', infinite_loop: 'Infinite Loop',
  stack_overflow: 'Stack Overflow', segfault: 'Segfault', unhandled_exception: 'Unhandled Exception',
  // test
  mock_failure: 'Mock Failure',
  // pipeline orchestration
  pipeline_stage_failure: 'Stage Failure', stage_order_error: 'Stage Order Error',
  invalid_trigger: 'Invalid Trigger', artifact_upload_failure: 'Artifact Upload',
  cache_restore_failure: 'Cache Restore', parallel_sync_issue: 'Parallel Sync',
  // git extended
  git_detached_head: 'Detached HEAD', git_commit_rejected: 'Commit Rejected',
  git_access_denied: 'Git Access Denied', git_invalid_branch: 'Invalid Branch',
  // deployment extended
  rollback_failure: 'Rollback Failed', failed_production_deploy: 'Prod Deploy Failed',
  blue_green_conflict: 'Blue-Green Conflict', canary_mismatch: 'Canary Mismatch',
  health_check_failure: 'Health Check Failed',
  // config
  invalid_gitlab_ci: 'Invalid GitLab CI', invalid_workflow_syntax: 'Invalid Workflow',
  missing_config_file: 'Missing Config', config_hierarchy_error: 'Config Hierarchy',
  unsupported_config_param: 'Unsupported Config', duplicate_config_key: 'Duplicate Config Key',
  env_mapping_error: 'Env Mapping Error',
  unknown: 'Unknown',
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function mttrDisplay(ms?: number): string {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function ConfidenceBar({ value }: { value?: number }) {
  if (value == null) return <span className="font-mono text-[9px] text-[#9A8678]/40">N/A</span>;
  const color = value >= 80 ? '#6A9A7A' : value >= 60 ? '#D4A574' : '#A06A6A';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1 bg-[#202940] overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
      <span className="font-mono text-[9px]" style={{ color }}>{value}%</span>
    </div>
  );
}

function RootCauseGraph({ event }: { event: HealingEventRecord }) {
  const failedJobs = event.failed_stage ? [event.failed_stage] : [];
  const nodeW = 100;
  const nodeH = 32;
  const svgW = 560;
  const svgH = 80;

  const nodes = [
    { id: 'commit',   label: 'COMMIT',          x: 20,  color: '#9A8678' },
    { id: 'pipeline', label: 'PIPELINE FAILED',  x: 155, color: '#A06A6A' },
    { id: 'job',      label: failedJobs[0] ? failedJobs[0].toUpperCase().substring(0, 14) : 'JOB FAILED', x: 290, color: '#A06A6A' },
    { id: 'fix',      label: 'FIX BRANCH',       x: 420, color: event.status === 'healed' ? '#6A9A7A' : '#D4A574' },
  ];

  return (
    <div className="mb-4">
      <div className="font-mono text-[9px] text-[#9A8678]/50 mb-2 tracking-widest">ROOT_CAUSE_GRAPH</div>
      <svg width={svgW} height={svgH} className="overflow-visible">
        {nodes.slice(0, -1).map((n, i) => {
          const next = nodes[i + 1];
          return (
            <g key={`arrow-${i}`}>
              <line
                x1={n.x + nodeW} y1={svgH / 2}
                x2={next.x} y2={svgH / 2}
                stroke="#9A8678" strokeWidth="1" strokeOpacity="0.3" strokeDasharray="3 3"
              />
              <polygon
                points={`${next.x},${svgH / 2 - 4} ${next.x + 6},${svgH / 2} ${next.x},${svgH / 2 + 4}`}
                fill="#9A8678" fillOpacity="0.4"
              />
            </g>
          );
        })}
        {nodes.map(n => (
          <g key={n.id}>
            <rect
              x={n.x} y={(svgH - nodeH) / 2}
              width={nodeW} height={nodeH}
              fill={n.color + '18'} stroke={n.color} strokeWidth="0.5" strokeOpacity="0.6"
            />
            <text
              x={n.x + nodeW / 2} y={svgH / 2 + 4}
              textAnchor="middle"
              fill={n.color} fontFamily="monospace" fontSize="8"
              opacity="0.9"
            >
              {n.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function EventCard({ event, groqKey, onPostmortumSaved }: {
  event: HealingEventRecord;
  groqKey: string;
  onPostmortumSaved: (id: number, text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [generatingPm, setGeneratingPm] = useState(false);
  const [pmError, setPmError] = useState('');

  const statusColor = event.status === 'healed' ? '#6A9A7A' : event.status === 'failed' ? '#A06A6A' : '#D4A574';
  const providerColor = event.provider === 'github' ? '#CAAA98' : '#9A8A7A';

  const handleGeneratePostmortem = async () => {
    if (!groqKey) { setPmError('Groq key required — add it in Settings'); return; }
    setGeneratingPm(true);
    setPmError('');
    try {
      const text = await generatePostmortem(groqKey, event);
      await apiUpdateEvent(event.id, { postmortem: text });
      onPostmortumSaved(event.id, text);
    } catch (err) {
      setPmError(err instanceof Error ? err.message : 'Failed to generate postmortem');
    } finally {
      setGeneratingPm(false);
    }
  };

  return (
    <motion.div
      className="border border-[#9A8678]/20 bg-[#0a0e1a]/60 overflow-hidden"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      {/* Row header */}
      <div
        className="flex items-center gap-3 p-4 cursor-pointer hover:bg-[#CAAA98]/5 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        {event.status === 'healed'  && <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: statusColor }} strokeWidth={1.5} />}
        {event.status === 'failed'  && <XCircle className="w-4 h-4 flex-shrink-0" style={{ color: statusColor }} strokeWidth={1.5} />}
        {event.status === 'healing' && <Loader2 className="w-4 h-4 flex-shrink-0 animate-spin" style={{ color: statusColor }} strokeWidth={1.5} />}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="font-mono text-xs text-[#CAAA98] truncate">{event.project_name}</span>
            <span className="font-mono text-[9px] border px-1.5 py-0.5 flex-shrink-0" style={{ borderColor: providerColor + '40', color: providerColor }}>
              {event.provider.toUpperCase()}
            </span>
            <span className="font-mono text-[9px] border px-1.5 py-0.5 flex-shrink-0" style={{ borderColor: statusColor + '40', color: statusColor }}>
              {event.status.toUpperCase()}
            </span>
            {/* Category badge — extracted from root_cause prefix [category] or failed_stage */}
            {(() => {
              const match = event.root_cause?.match(/^\[([^\]]+)\]/);
              const catKey = match?.[1] ?? '';
              const label = catKey ? (CATEGORY_LABELS[catKey] ?? catKey.replace(/_/g, ' ').toUpperCase()) : null;
              return label ? (
                <span className="font-mono text-[8px] border px-1.5 py-0.5 flex-shrink-0 border-[#7A9AC0]/40 text-[#7A9AC0]/80">
                  {label}
                </span>
              ) : null;
            })()}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-[#9A8678]/60 flex items-center gap-1">
              <GitBranch className="w-3 h-3" strokeWidth={1.5} />{event.branch}
            </span>
            {event.failed_stage && (
              <span className="font-mono text-[10px] text-[#9A8678]/50">stage:{event.failed_stage}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          <ConfidenceBar value={event.confidence} />
          <div className="flex items-center gap-1 font-mono text-[9px] text-[#9A8678]/50">
            <Clock className="w-3 h-3" strokeWidth={1.5} />{timeAgo(event.created_at)}
          </div>
          {event.recovery_time_ms && (
            <div className="flex items-center gap-1 font-mono text-[9px] text-[#6A9A7A]/60">
              <Cpu className="w-3 h-3" strokeWidth={1.5} />MTTR:{mttrDisplay(event.recovery_time_ms)}
            </div>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-[#9A8678]/40" strokeWidth={1.5} /> : <ChevronDown className="w-4 h-4 text-[#9A8678]/40" strokeWidth={1.5} />}
        </div>
      </div>

      {/* Expanded detail */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-[#CAAA98]/10 overflow-hidden"
          >
            <div className="p-4 space-y-4">
              <RootCauseGraph event={event} />

              {event.root_cause && (
                <div>
                  <div className="font-mono text-[9px] text-[#9A8678]/50 mb-1 tracking-widest">ROOT_CAUSE</div>
                  <div className="font-mono text-[11px] text-[#CAAA98]/80 leading-relaxed">
                    {event.root_cause.replace(/^\[[^\]]+\]\s*/, '')}
                  </div>
                </div>
              )}

              {(event.fix_steps ?? []).length > 0 && (
                <div>
                  <div className="font-mono text-[9px] text-[#9A8678]/50 mb-2 tracking-widest">FIX_STEPS_APPLIED</div>
                  <div className="space-y-1">
                    {event.fix_steps!.map((step, i) => (
                      <div key={i} className="font-mono text-[10px] text-[#6A9A7A]/80 flex items-start gap-2">
                        <span className="text-[#6A9A7A]/40 flex-shrink-0">▸</span>{step}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(event.ranked_fixes ?? []).length > 0 && (
                <div>
                  <div className="font-mono text-[9px] text-[#9A8678]/50 mb-2 tracking-widest">ALTERNATIVE_STRATEGIES_CONSIDERED</div>
                  <div className="space-y-1">
                    {event.ranked_fixes!.map((alt, i) => {
                      const riskColor = alt.risk === 'low' ? '#6A9A7A' : alt.risk === 'medium' ? '#D4A574' : '#A06A6A';
                      return (
                        <div key={i} className="flex items-center gap-2 font-mono text-[10px]">
                          <span className="text-[#9A8678]/40">{alt.confidence}%</span>
                          <span className="text-[#9A8678]/70 flex-1">{alt.description}</span>
                          <span className="text-[9px] border px-1" style={{ color: riskColor, borderColor: riskColor + '40' }}>
                            {alt.risk.toUpperCase()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Postmortem section */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="font-mono text-[9px] text-[#9A8678]/50 tracking-widest">POSTMORTEM_REPORT</div>
                  {!event.postmortem && (
                    <button
                      onClick={handleGeneratePostmortem}
                      disabled={generatingPm}
                      className="font-mono text-[9px] border border-[#CAAA98]/30 px-3 py-1 text-[#CAAA98]/60 hover:text-[#CAAA98] hover:border-[#CAAA98]/60 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                    >
                      {generatingPm
                        ? <><Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.5} /> GENERATING...</>
                        : <><FileText className="w-3 h-3" strokeWidth={1.5} /> GENERATE</>
                      }
                    </button>
                  )}
                </div>
                {pmError && (
                  <div className="font-mono text-[10px] text-[#A06A6A]/80 mb-2">{pmError}</div>
                )}
                {event.postmortem ? (
                  <pre className="font-mono text-[10px] text-[#9A8678]/70 leading-relaxed whitespace-pre-wrap border border-[#9A8678]/10 bg-[#0a0e1a]/80 p-3 max-h-64 overflow-y-auto custom-scrollbar">
                    {event.postmortem}
                  </pre>
                ) : (
                  !generatingPm && (
                    <div className="font-mono text-[10px] text-[#9A8678]/30 italic">
                      No postmortem generated yet — click GENERATE to create one with Gemini AI
                    </div>
                  )
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

type FilterStatus = 'all' | 'healed' | 'failed' | 'healing';

export function HistoryView({ groqKey, refreshKey }: HistoryViewProps) {
  const [events, setEvents] = useState<HealingEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const fetchingRef = useRef(false);

  const fetchEvents = () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    apiGetEvents()
      .then((data: HealingEventRecord[]) => {
        setEvents(data);
        setLoading(false);
        setLastFetched(new Date());
      })
      .catch(() => setLoading(false))
      .finally(() => { fetchingRef.current = false; });
  };

  // Initial load
  useEffect(() => { fetchEvents(); }, []);  

  // Immediate re-fetch whenever a new fix is committed (Dashboard bumps refreshKey)
  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) fetchEvents();
  }, [refreshKey]);  

  // Background poll every 5 s — fast enough to feel live
  useEffect(() => {
    const handle = setInterval(fetchEvents, 5_000);
    return () => clearInterval(handle);
  }, []);  

  const handlePostmortemSaved = (id: number, text: string) => {
    setEvents(prev => prev.map(e => e.id === id ? { ...e, postmortem: text } : e));
  };

  const filtered = filter === 'all' ? events : events.filter(e => e.status === filter);

  const counts = {
    all: events.length,
    healed: events.filter(e => e.status === 'healed').length,
    failed: events.filter(e => e.status === 'failed').length,
    healing: events.filter(e => e.status === 'healing').length,
  };

  const tabs: { id: FilterStatus; label: string; color: string }[] = [
    { id: 'all',     label: `ALL [${counts.all}]`,         color: '#CAAA98' },
    { id: 'healed',  label: `HEALED [${counts.healed}]`,   color: '#6A9A7A' },
    { id: 'failed',  label: `FAILED [${counts.failed}]`,   color: '#A06A6A' },
    { id: 'healing', label: `ACTIVE [${counts.healing}]`,  color: '#D4A574' },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-8 py-4 border-b border-[#CAAA98]/15 bg-[#0a0e1a]/40 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="font-mono text-xs text-[#CAAA98] tracking-widest">HEALING_HISTORY</div>
              <div className="flex items-center gap-1">
                <Radio size={8} className="text-[#6A9A7A] animate-pulse" />
                <span className="font-mono text-[8px] text-[#6A9A7A] tracking-widest">LIVE</span>
              </div>
            </div>
            <div className="font-mono text-[9px] text-[#9A8678]/40 mt-0.5">
              complete audit trail · updates every 5s
              {lastFetched && ` · synced ${lastFetched.toLocaleTimeString()}`}
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className="font-mono text-[9px] px-3 py-1.5 border tracking-widest transition-all"
                style={{
                  borderColor: filter === tab.id ? tab.color + '50' : 'transparent',
                  color: filter === tab.id ? tab.color : '#9A8678',
                  backgroundColor: filter === tab.id ? tab.color + '15' : 'transparent',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Event list */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-[#9A8678]/40 animate-spin" strokeWidth={1.5} />
            <span className="font-mono text-xs text-[#9A8678]/40 ml-3 tracking-widest">LOADING_HISTORY...</span>
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-20">
            <div className="font-mono text-xs text-[#9A8678]/40 tracking-widest">NO_EVENTS_FOUND</div>
            <div className="font-mono text-[10px] text-[#9A8678]/30 mt-2">
              {filter === 'all'
                ? 'Run a healing session to see history'
                : `No ${filter} events yet`}
            </div>
          </div>
        )}

        {!loading && (
          <div className="space-y-2 max-w-4xl">
            <AnimatePresence>
              {filtered.map(event => (
                <EventCard
                  key={event.id}
                  event={event}
                  groqKey={groqKey}
                  onPostmortumSaved={handlePostmortemSaved}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
