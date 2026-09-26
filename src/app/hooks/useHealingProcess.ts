import { useState, useRef, useCallback, useEffect } from 'react';
import { StreamEntry } from '../components/IntelligenceStream';
import { SystemStatus, Project } from '../types';
import { getAllLatestFailedRuns, getFailedRunsForBranch, getRunJobs, getWorkflowFiles, getJobLogs, createBranch, commitFile, createPR, waitForBranchCI, getOpenAegisPR } from '../lib/github';
import { getNewestPipelineOnRef, getFailedPipelineOnBranch, getPipelineJobs, getWorkflowFiles as getGitlabWorkflowFiles, getJobLogs as getGitlabJobLogs, createBranch as createGitlabBranch, commitFile as commitGitlabFile, createMR, waitForBranchPipeline } from '../lib/gitlab';
import { analyzeAndFixWithGemini } from '../lib/gemini';
import { analyzeAndFixWithGroq } from '../lib/groq';
import { analyzeWithGrounding } from '../lib/vertexai';
import type { ErrorCategory } from '../lib/diagnostics';
import { buildGithubContext, buildGitlabContext } from '../lib/contextBuilder';
import { confidenceToLevel } from '../lib/errorLevel';
import { getEmbedding } from '../lib/ai';
import { saveFailure, findSimilarFailure, timeAgoMs } from '../lib/failureMemory';
import { apiCreateEvent, apiUpdateEvent } from '../lib/backendApi';
import { chunkLogs, sanitizeForAI } from '../lib/sanitize';
import { validateFixes } from '../lib/fixValidator';
import { detectFingerprint } from '../lib/repoFingerprint';
import { GEMINI_MODEL, GROQ_MODEL } from '../lib/models';
import {
  type HealingRun, type FixSource, type StrategyId, emptyRun, startRun, withPhase, withFixes, withExtraFixes,
  withFixStatus, withOutcome, withStrategy, applyStreamMessage, inferOutcome,
} from '../lib/healingRun';
import { errorSignature, rememberFix, markVerified } from '../lib/strategies/knownFixes';
import type { FailingRun, Platform, StrategyContext } from '../lib/strategies/types';
import type { LadderResult } from '../lib/strategies/ladder';

const SOURCE_FOR: Record<StrategyId, FixSource> = { memory: 'memory', rules: 'rule', flaky: 'rule', autofix: 'autofix', ai: 'ai', revert: 'rule' };
const STRATEGY_NAME: Record<StrategyId, string> = {
  memory: 'replayed known fix', rules: 'deterministic rules', flaky: 'flaky check',
  autofix: "project's own auto-fixers", ai: 'AI analysis', revert: 'revert to last green',
};
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Confidence threshold below which user approval is required before applying fix
const APPROVAL_THRESHOLD = 65;

/** Pair a fix with the blob sha of the file it overwrites ('' = new file).
 *  Models often drop the directory ("ci.yml" for ".github/workflows/ci.yml"),
 *  so an unambiguous suffix match adopts the real path. The sha of a
 *  *different* file is never borrowed — GitHub rejects that commit. */
function withTargetSha<T extends { path: string }>(
  fix: T, files: Array<{ path: string; sha?: string }>,
): T & { sha: string } {
  const exact = files.find(w => w.path === fix.path);
  if (exact) return { ...fix, sha: exact.sha ?? '' };
  const bySuffix = files.filter(w => w.path.endsWith(`/${fix.path}`));
  if (bySuffix.length === 1) return { ...fix, path: bySuffix[0].path, sha: bySuffix[0].sha ?? '' };
  return { ...fix, sha: '' };
}

export interface PendingApproval {
  confidence: number;
  analysis: string;
  fixes: Array<{ path: string; explanation: string }>;
  alternatives: Array<{ description: string; confidence: number; risk: string }>;
}

interface HealingProcessOptions {
  projects: Project[];
  selectedProject: string | null;
  githubPat: string;
  gitlabPat: string;
  geminiKey: string;
  groqKey: string;
  gcloudKey?: string;
  safeMode?: boolean;
  onHealingComplete?: (id: string, status: 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_ERROR') => void;
  onEventUpdated?: () => void;
}

export function useHealingProcess({
  projects, selectedProject, githubPat, gitlabPat, geminiKey, groqKey, gcloudKey = '', safeMode = false, onHealingComplete, onEventUpdated,
}: HealingProcessOptions) {
  const [systemStatus, setSystemStatus] = useState<SystemStatus>('idle');
  const [activeNode, setActiveNode] = useState<string | undefined>(undefined);
  const [streamEntries, setStreamEntries] = useState<StreamEntry[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  // Structured view of the current run — drives the live graph, progress panel and diffs
  const [run, setRun] = useState<HealingRun>(emptyRun);

  const healingRef = useRef(false);
  // Bumped on every start/stop. A run only keeps acting while the id it was
  // started with is current — otherwise stopping and immediately restarting
  // would let the old run resume at its next await, alongside the new one.
  const runIdRef = useRef(0);
  const healingStartRef = useRef<number>(0);
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null);

  // Stop any in-flight run when the dashboard unmounts (logout / session expiry).
  useEffect(() => () => {
    runIdRef.current++;
    healingRef.current = false;
    approvalResolveRef.current?.(false);
    approvalResolveRef.current = null;
  }, []);

  const approveHealing = useCallback(() => {
    approvalResolveRef.current?.(true);
    approvalResolveRef.current = null;
    setPendingApproval(null);
  }, []);

  const cancelHealing = useCallback(() => {
    approvalResolveRef.current?.(false);
    approvalResolveRef.current = null;
    setPendingApproval(null);
  }, []);

  const waitForApproval = (data: PendingApproval): Promise<boolean> =>
    new Promise<boolean>(resolve => {
      setPendingApproval(data);
      approvalResolveRef.current = resolve;
    });

  const resetHealing = () => {
    runIdRef.current++;
    setRun(emptyRun());
    healingRef.current = false;
    if (approvalResolveRef.current) {
      approvalResolveRef.current(false);
      approvalResolveRef.current = null;
      setPendingApproval(null);
    }
    setSystemStatus('idle');
    setActiveNode(undefined);
    setStreamEntries([]);
  };

  /** Start (or, if one is running, stop) a heal. `projectId` lets auto-heal target a repo directly. */
  const healRepo = async (projectId?: string) => {
    if (healingRef.current) {
      runIdRef.current++;
      setRun(r => (r.startedAt && !r.outcome ? withOutcome(r, 'cancelled', 'Stopped by operator') : r));
      healingRef.current = false;
      if (approvalResolveRef.current) {
        approvalResolveRef.current(false);
        approvalResolveRef.current = null;
        setPendingApproval(null);
      }
      setSystemStatus('idle');
      setActiveNode(undefined);
      return;
    }

    const project = projects.find(p => p.id === (projectId ?? selectedProject));
    if (!project) return;

    const runId = ++runIdRef.current;
    const cancelled = () => !healingRef.current || runIdRef.current !== runId;
    // End-of-run cleanup — a superseded run must not clear the flag of the run that replaced it.
    // Structured run state for the UI. Every update is dropped once this run is superseded.
    let lastDecision = '';
    const track = (fn: (r: HealingRun) => HealingRun) => { if (runIdRef.current === runId) setRun(fn); };
    const endRun = () => {
      if (runIdRef.current !== runId) return;
      healingRef.current = false;
      setActiveNode(undefined);
      const decision = lastDecision;
      setRun(r => {
        if (r.outcome) return r;
        const o = inferOutcome(r, decision);
        return withOutcome(r, o.kind, o.reason);
      });
    };

    healingRef.current = true;
    healingStartRef.current = Date.now();
    setRun(startRun());
    setSystemStatus('healing');
    // ~1,000 rules + the strategy ladder — code-split out of the initial bundle.
    const {
      applyRuleBasedFixes, categorizeAllErrors, clusterRootCauses, crossFileConsistencyCheck,
      runHealingLadder, revertToLastGreen, runAutofixJob,
    } = await import('../lib/healEngine');
    setStreamEntries([]);
    setLogs([]);
    setShowLogs(false);

    const ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });
    let entryId = 0;

    const add = (entry: Omit<StreamEntry, 'id'>) => {
      if (cancelled()) return;
      const e: StreamEntry = { ...entry, id: String(++entryId) };
      setStreamEntries(prev => [...prev, e]);
      if (e.type === 'decision' || (e.type === 'result' && e.status === 'failure')) lastDecision = e.message;
      if (e.message.startsWith('FIX_VERIFIED') && healSignature) markVerified(repoKey, healSignature);
      track(r => applyStreamMessage(r, e.message, e.url));
      setLogs(prev => [...prev, `[${e.timestamp ?? ts()}] ${e.message}`]);
    };

    let trackedEventId: number | null = null;
    let eventFinalized = false;
    const createEvent = async (ev: Parameters<typeof apiCreateEvent>[0]) => {
      try {
        const created = await apiCreateEvent(ev);
        trackedEventId = created.id;
        return created;
      } catch (err) {
        add({ type: 'info', message: `HISTORY_UNAVAILABLE :: ${err instanceof Error ? err.message : 'backend_error'} — healing continues without event tracking`, timestamp: ts() });
        return null;
      }
    };
    const updateEvent = async (id: number, patch: Parameters<typeof apiUpdateEvent>[1]) => {
      if (patch.status && patch.status !== 'healing') eventFinalized = true;
      await apiUpdateEvent(id, patch).catch(() => { /* history only — never block healing */ });
    };

    // ── Healing-ladder plumbing shared by the GitHub and GitLab flows ──────────
    const repoKey = `${project.owner ?? ''}/${project.repoName ?? ''}`;
    let healSignature = '';
    let escalation: (() => Promise<void>) | undefined; // set per platform once the failing runs are known
    const markStrategy = (id: StrategyId, state: 'active' | 'done' | 'failed' | 'skipped', note?: string) =>
      track(r => withStrategy(r, id, state, note));
    const strategyCtx = (platform: Platform, runs: FailingRun[], branchName: string): StrategyContext => ({
      platform, pat: platform === 'gitlab' ? gitlabPat : githubPat,
      owner: project.owner ?? '', repo: project.repoName ?? '', branch: branchName, failingRuns: runs,
      isCancelled: cancelled,
      log: (message, kind = 'info') => add({
        type: kind === 'attempt' ? 'attempt' : kind === 'ok' || kind === 'fail' ? 'result' : 'info',
        status: kind === 'ok' ? 'success' : kind === 'fail' ? 'failure' : undefined,
        message, timestamp: ts(),
      }),
    });
    const approvalGate = async (a: PendingApproval) => {
      setSystemStatus('idle');
      const ok = await waitForApproval(a);
      if (!cancelled()) setSystemStatus('healing');
      return ok;
    };
    /** Handle ladder outcomes that end the run. Returns true when the run is finished. */
    const finishLadder = async (res: LadderResult, eventId: number | null): Promise<boolean> => {
      if (res.kind === 'cancelled') return true;
      if (res.kind === 'flaky') {
        if (eventId !== null) await updateEvent(eventId, { status: 'healed', root_cause: 'Flaky failure — the failed jobs passed on rerun; no code change was needed', confidence: 90, recovery_time_ms: Date.now() - healingStartRef.current });
        onEventUpdated?.();
        track(r => withOutcome(r, 'flaky', 'The failed jobs passed when re-run — the code is fine, nothing was changed'));
        setSystemStatus('healthy');
        onHealingComplete?.(project.id, 'NO_ERROR');
        endRun();
        return true;
      }
      if (res.kind === 'reverted') {
        add({ type: 'result', message: `PR_CREATED :: ${res.label}${res.verified ? ' — CI green on the revert' : ' — CI will run on the PR'}`, status: 'success', url: res.prUrl, timestamp: ts() });
        if (eventId !== null) await updateEvent(eventId, { status: 'healed', root_cause: `Reverted to last green build: ${res.label}`, fix_steps: [res.label], confidence: res.verified ? 90 : 70, recovery_time_ms: Date.now() - healingStartRef.current });
        onEventUpdated?.();
        track(r => withOutcome(r, 'healed', `Opened a revert PR (${res.label})${res.verified ? ' — CI passed on it' : ''}`));
        setSystemStatus('healthy');
        onHealingComplete?.(project.id, confidenceToLevel(res.verified ? 90 : 70, true));
        endRun();
        return true;
      }
      if (res.kind === 'rejected') {
        add({ type: 'decision', message: 'HEALING_CANCELLED :: operator_rejected_low_confidence_fix', timestamp: ts() });
        if (eventId !== null) await updateEvent(eventId, { status: 'failed', root_cause: res.analysis || 'operator_rejected_low_confidence_fix', confidence: res.confidence });
        onEventUpdated?.();
        setSystemStatus('stopped');
        onHealingComplete?.(project.id, 'HIGH');
        endRun();
        return true;
      }
      if (res.kind === 'none') add({ type: 'info', message: `LADDER_EXHAUSTED :: ${res.reason}`, timestamp: ts() });
      return false;
    };
    /** Regenerate the lockfile in CI after a fix changed declared dependencies. */
    const refreshLockfile = async (
      platform: Platform, fixBranchName: string, files: Array<{ path: string; content: string }>,
      commit: (path: string, content: string) => Promise<boolean>,
    ) => {
      if (!files.some(f => LOCKFILES.test(f.path))) return; // no lockfile committed — nothing to keep in sync
      add({ type: 'attempt', message: 'LOCKFILE_REFRESH :: dependencies changed — regenerating the lockfile in CI', timestamp: ts() });
      const res = await runAutofixJob(strategyCtx(platform, [], fixBranchName), fixBranchName, files, 'lockfile');
      const lock = res.changed.filter(c => LOCKFILES.test(c.path));
      if (res.status !== 'ok' || lock.length === 0) {
        add({ type: 'info', message: `LOCKFILE_REFRESH :: ${res.note ?? res.status} — run your package manager's install and commit the lockfile before merging`, timestamp: ts() });
        return;
      }
      track(r => withExtraFixes(r, lock.map(c => ({ ...c, explanation: `Regenerated by ${res.tools.join(', ')} to match the updated package.json` })), files, 'lockfile'));
      for (const c of lock) {
        const ok = await commit(c.path, c.content);
        track(r => withFixStatus(r, c.path, ok ? 'committed' : 'failed'));
        add({ type: 'result', message: ok ? `fix_committed :: lockfile path=${c.path}` : `commit_failed :: path=${c.path}`, status: ok ? 'success' : 'failure', timestamp: ts() });
      }
    };

    const isGitLab = project.platform === 'gitlab';
    const effectivePat = isGitLab ? gitlabPat : githubPat;
    const platformLabel = isGitLab ? 'gitlab.com' : 'github.com';
    const aiModel = groqKey ? `${GROQ_MODEL} (groq)` : gcloudKey ? `${GEMINI_MODEL} (grounded)` : GEMINI_MODEL;
    const aiKey = groqKey || gcloudKey || geminiKey;

    // ── REAL MODE ────────────────────────────────────────────────────────────────
    if (project.owner && project.repoName && effectivePat) {
      const { owner, repoName } = project;
      const branch = project.repo || 'main';

      try {
        add({ type: 'info', message: `connecting_to :: ${platformLabel}/${owner}/${repoName}`, timestamp: ts() });
        await delay(600); if (cancelled()) return;

        // ── GitLab flow ──────────────────────────────────────────────────────────
        if (isGitLab) {
          add({ type: 'info', message: 'fetching_pipelines :: status=failed', timestamp: ts() });
          setActiveNode('code-push');
          // The newest pipeline on the repo's own branch, if it is red. (A failure on some other
          // ref must not be "fixed" with this branch's files.)
          const newestPipeline = await getNewestPipelineOnRef(effectivePat, owner, repoName, branch);
          const failedPipeline = newestPipeline && ['failed', 'canceled'].includes(newestPipeline.status) ? newestPipeline : null;
          await delay(400); if (cancelled()) return;

          if (!failedPipeline) {
            add({ type: 'decision', message: 'NO_FAILURES_DETECTED :: repository_ci_status=clean', timestamp: ts() });
            setSystemStatus('healthy');
            onHealingComplete?.(project.id, 'NO_ERROR');
            endRun();
            return;
          }

          const shortSha = failedPipeline.sha?.substring(0, 7) ?? 'unknown';
          add({ type: 'detected', message: `pipeline_failure :: id=${failedPipeline.id} ref=${failedPipeline.ref} sha=${shortSha}`, timestamp: ts() });
          track(r => ({ ...r, failure: { workflows: [`pipeline #${failedPipeline.id}`], jobs: [], steps: [], url: failedPipeline.web_url, sha: shortSha } }));
          const glEvent = await createEvent({ pipeline_id: failedPipeline.id, project_name: `${owner}/${repoName}`, branch: failedPipeline.ref, provider: 'gitlab', status: 'healing' });
          await delay(500); if (cancelled()) return;

          setActiveNode('pipeline');
          const jobs = await getPipelineJobs(effectivePat, owner, repoName, failedPipeline.id);
          const failedJobs = jobs.filter(j => j.status === 'failed');
          track(r => ({ ...r, failure: r.failure && { ...r.failure, jobs: failedJobs.map(j => j.name), steps: failedJobs.map(j => j.stage) } }));
          if (failedJobs.length > 0) {
            add({ type: 'info', message: `failed_jobs=${failedJobs.length} :: [${failedJobs.map(j => j.name).slice(0, 3).join(', ')}]`, timestamp: ts() });
          }
          await delay(400); if (cancelled()) return;

          add({ type: 'attempt', message: `#1 :: strategy=fetch_ci_config target=.gitlab-ci.yml`, timestamp: ts() });
          setActiveNode('error-detection');
          const ciFiles = await getGitlabWorkflowFiles(effectivePat, owner, repoName, branch);
          await delay(600); if (cancelled()) return;

          if (ciFiles.length === 0) {
            add({ type: 'result', message: `execution_failed :: reason=no_ci_config_found exit_code=1`, status: 'failure', timestamp: ts() });
            add({ type: 'decision', message: 'HALT_EXECUTION :: manual_intervention_required', timestamp: ts() });
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: 'no_ci_config_found' });
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }
          add({ type: 'result', message: `ci_config_fetched :: [${ciFiles.map(f => f.path).join(', ')}]`, status: 'success', timestamp: ts() });
          await delay(300); if (cancelled()) return;

          let glFixes: Array<{ path: string; content: string; explanation: string }> = [];
          let glContextFiles: Array<{ path: string; content: string }> = [];
          let aiConfidence = 75;
          let aiAnalysis = '';
          let aiRankedAlternatives: Array<{ description: string; confidence: number; risk: string }> = [];
          let aiSources: Array<{ title: string; url: string }> = [];
          let fixStrategy: StrategyId = 'rules';
          let needsLockfileRefresh = false;
          const glRuns: FailingRun[] = [{ id: failedPipeline.id, name: `pipeline #${failedPipeline.id}`, headSha: failedPipeline.sha }];
          escalation = async () => {
            if (fixStrategy === 'revert') return;
            escalation = undefined; // once per run
            add({ type: 'attempt', message: 'ESCALATE :: fix branch still red after the deep pass — reverting to the last green build', timestamp: ts() });
            markStrategy('revert', 'active');
            const rev = await revertToLastGreen(strategyCtx('gitlab', glRuns, branch));
            if (rev.status === 'reverted' && rev.prUrl) {
              markStrategy('revert', 'done', `${rev.label}${rev.verified ? ' — CI green' : ''}`);
              add({ type: 'result', message: `REVERT_MR :: ${rev.label} — merge this instead of the fix MR`, status: 'success', url: rev.prUrl, timestamp: ts() });
            } else {
              markStrategy('revert', 'failed', rev.note ?? rev.status);
            }
          };

          add({ type: 'attempt', message: `#2 :: strategy=healing_ladder ai=${aiKey ? aiModel : 'none'}`, timestamp: ts() });
          setActiveNode('fix-engine');

          // Logs for all failed jobs — the rules, the flaky check and the AI all need them
          const allGlJobLogs = await Promise.all(
            failedJobs.slice(0, 3).map(async j => {
              if (!j.id) return '';
              const raw = await getGitlabJobLogs(effectivePat, owner, repoName, j.id).catch(() => '');
              return `\nJob "${j.name}" logs:\n${chunkLogs(raw)}`;
            }),
          );
          const glLogs = allGlJobLogs.join('\n');
          const glMultiDiag = categorizeAllErrors(glLogs, failedJobs.map(j => j.name));
          const glDiagnosis = glMultiDiag.primary;
          const glAllCategories = glMultiDiag.all.map(d => d.category);
          const glClusters = clusterRootCauses(glAllCategories);
          const categoryLabel = glMultiDiag.all.length > 1
            ? `${glDiagnosis.category} (+${glMultiDiag.all.length - 1} more: ${glMultiDiag.all.slice(1).map(d => d.category).join(', ')})`
            : glDiagnosis.category;
          track(r => ({ ...r, categories: glAllCategories }));
          add({ type: 'info', message: `ERROR_DIAGNOSED :: categories=[${categoryLabel}] :: ${glDiagnosis.description}`, timestamp: ts() });
          if (glClusters.some(c => c.categories.length > 1)) {
            add({ type: 'info', message: `ROOT_CAUSE_CLUSTER :: ${glClusters.filter(c => c.categories.length > 1).map(c => `${c.rootCause}=[${c.categories.join('+')}]`).join(' | ')}`, timestamp: ts() });
          }

          // Files for ALL matched categories + every source file the logs point at
          const glContext = await buildGitlabContext(effectivePat, owner, repoName, branch, ciFiles, glMultiDiag.all, glLogs);
          glContextFiles = glContext.allFiles;
          if (glContext.additionalFiles.length > 0) {
            add({ type: 'info', message: `CONTEXT_EXPANDED :: fetched=[${glContext.additionalFiles.map(f => f.path).join(', ')}]`, timestamp: ts() });
          }
          const glFingerprint = detectFingerprint(glContext.allFiles);
          add({ type: 'info', message: `REPO_FINGERPRINT :: ${glFingerprint.summary}`, timestamp: ts() });

          const errorContext = sanitizeForAI([
            `Repository stack: ${glFingerprint.summary}`,
            `Languages: [${glFingerprint.languages.join(', ')}] Frameworks: [${glFingerprint.frameworks.join(', ')}]`,
            `Failed pipeline: id=${failedPipeline.id} (${failedPipeline.web_url})`,
            `Ref: ${failedPipeline.ref} SHA: ${shortSha}`,
            `Failed jobs: ${failedJobs.map(j => j.name).join(', ') || 'none'}`,
            ...allGlJobLogs.filter(Boolean),
          ].join('\n'));

          if (geminiKey) {
            const embedding = await getEmbedding(geminiKey, errorContext);
            const similar = embedding.length > 0 ? findSimilarFailure(embedding) : null;
            if (similar) {
              add({ type: 'info', message: `MEMORY_MATCH :: similar_failure_found ${timeAgoMs(similar.record.timestamp)} (${Math.round(similar.similarity * 100)}% match) — ${similar.record.fixes[0]?.explanation ?? 'see past fix'}`, timestamp: ts() });
            }
          }

          healSignature = errorSignature(glLogs, glAllCategories);
          const glLadder = await runHealingLadder({
            ctx: strategyCtx('gitlab', glRuns, branch), repoKey, signature: healSignature,
            logs: glLogs, categories: glAllCategories, diagnoses: glMultiDiag.all, files: glContext.allFiles,
            errorContext, keys: { gemini: geminiKey, groq: groqKey, gcloud: gcloudKey },
            approvalThreshold: APPROVAL_THRESHOLD, requestApproval: approvalGate, onStrategy: markStrategy,
          });
          if (await finishLadder(glLadder, glEvent?.id ?? null)) return;
          if (glLadder.kind === 'fixes') {
            glFixes = glLadder.fixes;
            fixStrategy = glLadder.strategy;
            needsLockfileRefresh = glLadder.needsLockfileRefresh;
            aiConfidence = glLadder.confidence;
            aiAnalysis = glLadder.analysis;
            aiRankedAlternatives = glLadder.alternatives;
            aiSources = glLadder.sources;
            track(r => ({ ...withFixes(r, glFixes, glContext.allFiles, SOURCE_FOR[fixStrategy]), engine: fixStrategy, confidence: aiConfidence }));
          }
          await delay(300); if (cancelled()) return;

          // ── Fix safety validation ────────────────────────────────────────────
          track(r => withPhase(r, 'validate', 'active'));
          // Filter out malformed AI fixes (missing path/content) before validation
          glFixes = glFixes.filter(f => f.path && typeof f.path === 'string' && f.content && typeof f.content === 'string');
          if (glFixes.length > 0) {
            const { safeFixes, results } = validateFixes(glFixes, glContextFiles);
            for (const r of results) {
              if (r.blocked.length > 0) {
                add({ type: 'info', message: `FIX_BLOCKED :: path=${r.path} :: ${r.blocked.join(' | ')}`, timestamp: ts() });
              }
              if (r.warnings.length > 0) {
                add({ type: 'info', message: `FIX_WARNING :: path=${r.path} :: ${r.warnings.join(' | ')}`, timestamp: ts() });
              }
            }
            const blocked = results.filter(r => !r.safe).length;
            if (blocked > 0) {
              add({ type: 'info', message: `VALIDATION :: ${safeFixes.length}/${glFixes.length} fixes passed safety checks — ${blocked} blocked`, timestamp: ts() });
            }
            for (const res of results) {
              if (!res.safe) track(r => withFixStatus(r, res.path, 'blocked', res.blocked.join('; ')));
            }
            glFixes = safeFixes;
          }

          if (glFixes.length === 0) {
            add({ type: 'decision', message: 'HALT_EXECUTION :: no_fixes_available manual_intervention_required', timestamp: ts() });
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: 'no_fixes_generated' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }

          // ── Safe mode — analysis only, no branch/commit/MR ──────────────────
          if (safeMode) {
            add({ type: 'decision', message: `SAFE_MODE :: analysis_complete fixes_ready=${glFixes.length} — skipping_apply`, timestamp: ts() });
            for (const f of glFixes) {
              add({ type: 'info', message: `PROPOSED_FIX :: ${f.path} — ${f.explanation.substring(0, 80)}`, timestamp: ts() });
            }
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: `[SAFE_MODE] ${aiAnalysis || 'analysis_only'}`, confidence: aiConfidence });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, confidenceToLevel(aiConfidence, false));
            endRun();
            return;
          }

          const glFixBranch = `aegis/fix-${Date.now()}`;
          add({ type: 'attempt', message: `#3 :: strategy=create_branch name=${glFixBranch}`, timestamp: ts() });
          const glBranchOk = await createGitlabBranch(effectivePat, owner, repoName, glFixBranch, branch);
          await delay(500); if (cancelled()) return;

          if (!glBranchOk) {
            add({ type: 'result', message: `execution_failed :: reason=branch_creation_failed check_token_permissions`, status: 'failure', timestamp: ts() });
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: 'branch_creation_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }
          add({ type: 'result', message: `branch_created :: ${glFixBranch}`, status: 'success', timestamp: ts() });
          await delay(300); if (cancelled()) return;

          let glCommitted = 0;
          for (let i = 0; i < glFixes.length; i++) {
            const fix = glFixes[i];
            add({ type: 'attempt', message: `#${4 + i} :: strategy=commit_fix path=${fix.path}`, timestamp: ts() });
            const ok = await commitGitlabFile(effectivePat, owner, repoName, fix.path, fix.content, `fix(aegis): ${fix.explanation.substring(0, 60)}`, glFixBranch);
            await delay(400); if (cancelled()) return;
            if (ok) {
              add({ type: 'result', message: `fix_committed :: path=${fix.path}`, status: 'success', timestamp: ts() });
              glCommitted++;
            } else {
              add({ type: 'result', message: `commit_failed :: path=${fix.path} check_write_permissions`, status: 'failure', timestamp: ts() });
            }
          }

          if (glCommitted === 0) {
            add({ type: 'decision', message: 'HALT_EXECUTION :: all_commits_failed', timestamp: ts() });
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: 'all_commits_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }

          if (needsLockfileRefresh) {
            await refreshLockfile('gitlab', glFixBranch, glContextFiles,
              (path, content) => commitGitlabFile(effectivePat, owner, repoName, path, content, 'fix(aegis): regenerate lockfile', glFixBranch).then(Boolean));
            if (cancelled()) return;
          }
          const mrTitle = `fix(aegis): auto-fix CI failure via ${STRATEGY_NAME[fixStrategy]} [conf:${aiConfidence}%]`;
          add({ type: 'attempt', message: `#${4 + glFixes.length} :: strategy=create_merge_request base=${branch}`, timestamp: ts() });
          const mrBody = [
            `## AEGIS Auto-Fix`,
            ``,
            `> Generated by AEGIS autonomous healing system`,
            `> Strategy: **${STRATEGY_NAME[fixStrategy]}** · Confidence: **${aiConfidence}%**`,
            ``,
            `**Failed pipeline:** ${failedPipeline.web_url}`,
            ``,
            `### Changes`,
            ...glFixes.map(f => `- \`${f.path}\`: ${f.explanation}`),
            ``,
            `### Alternative Strategies Considered`,
            ...(aiRankedAlternatives.length > 0
              ? aiRankedAlternatives.map(a => `- [${a.confidence}% | risk:${a.risk}] ${a.description}`)
              : ['_None_']),
          ].join('\n');
          const mrUrl = await createMR(effectivePat, owner, repoName, mrTitle, mrBody, glFixBranch, branch);
          await delay(500); if (cancelled()) return;

          if (mrUrl) {
            const recoveryTimeMs = Date.now() - healingStartRef.current;
            add({ type: 'result', message: `MR_CREATED :: confidence=${aiConfidence}% recovery=${Math.round(recoveryTimeMs / 1000)}s`, status: 'success', url: mrUrl, timestamp: ts() });
            if (healSignature) rememberFix(repoKey, healSignature, glFixes.map(f => ({ path: f.path, before: glContextFiles.find(c => c.path === f.path)?.content ?? null, after: f.content, explanation: f.explanation })), false);
            if (glEvent) await updateEvent(glEvent.id, {
              status: 'healed',
              root_cause: aiAnalysis,
              fix_steps: glFixes.map(f => f.explanation),
              confidence: aiConfidence,
              ranked_fixes: aiRankedAlternatives,
              sources: aiSources,
              recovery_time_ms: recoveryTimeMs,
            });
            onEventUpdated?.();
            setSystemStatus('healthy');
            onHealingComplete?.(project.id, confidenceToLevel(aiConfidence, true));

            if (geminiKey) {
              try {
                const errorContext = `Failed pipeline: id=${failedPipeline.id} Ref: ${failedPipeline.ref} Failed jobs: ${failedJobs.map(j => j.name).join(', ')}`;
                const embedding = await getEmbedding(geminiKey, errorContext);
                saveFailure({
                  id: `${owner}-${repoName}-${failedPipeline.id}`,
                  repoName: `${owner}/${repoName}`,
                  errorContext,
                  fixes: glFixes.map(f => ({ path: f.path, explanation: f.explanation })),
                  embedding,
                  timestamp: Date.now(),
                });
              } catch { /* memory save must not affect healing outcome */ }
            }

            // Verify fix by polling CI on the fix branch (non-blocking — max 60s)
            add({ type: 'attempt', message: `VERIFY_FIX :: polling_ci branch=${glFixBranch} max_wait=60s`, timestamp: ts() });
            const glCiVerify = await waitForBranchPipeline(effectivePat, owner, repoName, glFixBranch, 60_000, 15_000);
            if (cancelled()) return;
            if (glCiVerify === 'success') {
              add({ type: 'result', message: `FIX_VERIFIED :: ci_green branch=${glFixBranch} — fix_confirmed_working`, status: 'success', timestamp: ts() });
            } else if (glCiVerify === 'timeout') {
              add({ type: 'info', message: `VERIFY_TIMEOUT :: ci_still_running after_60s — monitor_MR_directly`, timestamp: ts() });
            } else {
              // CI is still red — run a deep second-pass diagnosis on the fix branch
              add({ type: 'result', message: `FIX_UNVERIFIED :: ci_red branch=${glFixBranch} — starting deep_diagnosis_pass`, status: 'failure', timestamp: ts() });
              {
                try {
                  await delay(6_000); if (cancelled()) return;
                  add({ type: 'attempt', message: `DEEP_DIAGNOSIS :: fetching fix-branch CI logs for second pass`, timestamp: ts() });
                  const deepPipeline = await getFailedPipelineOnBranch(effectivePat, owner, repoName, glFixBranch);
                  if (deepPipeline) {
                    const deepJobs = await getPipelineJobs(effectivePat, owner, repoName, deepPipeline.id);
                    const deepFailedJobs = deepJobs.filter(j => j.status === 'failed');
                    const deepLogs = await Promise.all(
                      deepFailedJobs.slice(0, 3).map(async j => {
                        if (!j.id) return '';
                        const raw = await getGitlabJobLogs(effectivePat, owner, repoName, j.id).catch(() => '');
                        return `\nJob "${j.name}" logs:\n${chunkLogs(raw)}`;
                      }),
                    );
                    const deepStepNames = deepFailedJobs.map(j => j.name);
                    const deepDiag = categorizeAllErrors(deepLogs.join('\n'), deepStepNames);
                    const deepCategories = deepDiag.all.map(d => d.category);
                    const deepClusters = clusterRootCauses(deepCategories);
                    const deepCatLabel = deepCategories.length > 1
                      ? `${deepDiag.primary.category} (+${deepCategories.length - 1} more)`
                      : deepDiag.primary.category;
                    add({ type: 'info', message: `DEEP_DIAGNOSIS :: categories=[${deepCatLabel}] root_causes=[${deepClusters.map(c => c.rootCause).slice(0, 3).join(', ')}]`, timestamp: ts() });

                    // Fetch current state from fix branch
                    const deepCiFiles = await getGitlabWorkflowFiles(effectivePat, owner, repoName, glFixBranch);
                    const deepContext = await buildGitlabContext(effectivePat, owner, repoName, glFixBranch, deepCiFiles, deepDiag.all, deepLogs.join('\n'));

                    let deepGlFixes: Array<{ path: string; content: string; explanation: string }> = [];
                    const deepRuleFixes = applyRuleBasedFixes(deepCategories, deepLogs.join('\n'), deepContext.allFiles);
                    if (deepRuleFixes.length > 0) {
                      add({ type: 'result', message: `DEEP_FIX :: rule_match=${deepRuleFixes.length} patterns categories=[${deepCategories.slice(0, 3).join(', ')}]`, status: 'success', timestamp: ts() });
                      deepGlFixes = deepRuleFixes;
                    } else {
                      const deepErrCtx = sanitizeForAI([
                        `SECOND-PASS: CI still red on fix branch after first fix was applied.`,
                        `Remaining failed jobs: ${deepFailedJobs.map(j => j.name).join(', ') || 'none'}`,
                        ...deepLogs.filter(Boolean),
                      ].join('\n'));
                      let deepResult = gcloudKey ? await analyzeWithGrounding(gcloudKey, deepErrCtx, deepContext.allFiles) : null;
                      if (!deepResult || deepResult.fixes.length === 0) {
                        if (groqKey) deepResult = await analyzeAndFixWithGroq(groqKey, deepErrCtx, deepContext.allFiles, deepDiag.all);
                      }
                      if (!deepResult || deepResult.fixes.length === 0) {
                        if (geminiKey) deepResult = await analyzeAndFixWithGemini(geminiKey, deepErrCtx, deepContext.allFiles, deepDiag.primary);
                      }
                      if (deepResult && deepResult.fixes.length > 0) {
                        const short = deepResult.analysis.length > 80 ? deepResult.analysis.substring(0, 80) + '…' : deepResult.analysis;
                        add({ type: 'result', message: `DEEP_FIX :: ai conf=${deepResult.confidence}% :: ${short}`, status: 'success', timestamp: ts() });
                        deepGlFixes = deepResult.fixes.map(f => withTargetSha(f, deepContext.allFiles));
                      }
                    }

                    // Validate + commit deep fixes to the existing MR branch
                    deepGlFixes = deepGlFixes.filter(f => f.path && typeof f.path === 'string' && f.content && typeof f.content === 'string');
                    if (deepGlFixes.length > 0) {
                      const { safeFixes: deepSafe } = validateFixes(deepGlFixes, deepContext.allFiles);
                      track(r => withExtraFixes(r, deepSafe, deepContext.allFiles, 'deep'));
                      let deepCommitted = 0;
                      for (const fix of deepSafe) {
                        track(r => withFixStatus(r, fix.path, 'committing'));
                        const ok = await commitGitlabFile(effectivePat, owner, repoName, fix.path, fix.content,
                          `fix(aegis-deep): ${fix.explanation.substring(0, 60)}`, glFixBranch);
                        await delay(300); if (cancelled()) return;
                        track(r => withFixStatus(r, fix.path, ok ? 'committed' : 'failed'));
                        if (ok) deepCommitted++;
                      }
                      if (deepCommitted > 0) {
                        add({ type: 'info', message: `DEEP_FIX :: committed=${deepCommitted} to ${glFixBranch} — re-checking CI max_wait=90s`, timestamp: ts() });
                        const deepVerify = await waitForBranchPipeline(effectivePat, owner, repoName, glFixBranch, 90_000, 15_000);
                        if (cancelled()) return;
                        if (deepVerify === 'success') {
                          add({ type: 'result', message: `FIX_VERIFIED :: ci_green after deep diagnosis pass`, status: 'success', timestamp: ts() });
                        } else if (deepVerify === 'failure') {
                          add({ type: 'result', message: `DEEP_UNVERIFIED :: ci_red after 2 passes — see MR for manual investigation`, status: 'failure', timestamp: ts() });
                          await escalation?.();
                        } else {
                          add({ type: 'info', message: `DEEP_VERIFY_TIMEOUT :: ci_still_running — monitor MR directly`, timestamp: ts() });
                        }
                      } else {
                        add({ type: 'info', message: `DEEP_FIX :: no_new_commits — all additional fixes blocked by validator or already applied`, timestamp: ts() });
                        await escalation?.();
                      }
                    } else {
                      add({ type: 'info', message: `DEEP_DIAGNOSIS :: no_additional_fixes_found — remaining failures require manual intervention`, timestamp: ts() });
                      await escalation?.();
                    }
                  } else {
                    add({ type: 'info', message: `DEEP_DIAGNOSIS :: no_failed_pipeline_on_branch_yet — CI may still be initializing`, timestamp: ts() });
                  }
                } catch { /* deep pass must not affect the MR already created */ }
              }
            }
          } else {
            add({ type: 'result', message: `mr_creation_failed :: branch=${glFixBranch} exists with commits`, status: 'failure', timestamp: ts() });
            if (glEvent) await updateEvent(glEvent.id, { status: 'failed', root_cause: 'mr_creation_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
          }

        } else {
          // ── GitHub flow ──────────────────────────────────────────────────────
          add({ type: 'info', message: 'fetching_workflow_runs :: status=failure', timestamp: ts() });
          setActiveNode('code-push');
          // Fetch the most-recent failure for EACH unique workflow so we can
          // fix all failing pipelines (CI, Deploy, Security…) in one PR.
          const allFailedRuns = await getAllLatestFailedRuns(effectivePat, owner, repoName, branch);
          await delay(400); if (cancelled()) return;

          if (allFailedRuns.length === 0) {
            add({ type: 'decision', message: 'NO_FAILURES_DETECTED :: repository_ci_status=clean', timestamp: ts() });
            setSystemStatus('healthy');
            onHealingComplete?.(project.id, 'NO_ERROR');
            endRun();
            return;
          }

          // Use the first (most recent) run as the primary for event tracking
          const failedRun = allFailedRuns[0];
          const shortSha = failedRun.head_commit?.id?.substring(0, 7) ?? 'unknown';
          add({
            type: 'detected',
            message: `ci_failure :: workflows=${allFailedRuns.length} [${allFailedRuns.map(r => r.name).join(', ')}] commit=${shortSha}`,
            timestamp: ts(),
          });
          track(r => ({ ...r, failure: { workflows: allFailedRuns.map(x => x.name), jobs: [], steps: [], url: failedRun.html_url, sha: shortSha } }));
          const ghEvent = await createEvent({ pipeline_id: failedRun.id, project_name: `${owner}/${repoName}`, branch, provider: 'github', failed_stage: allFailedRuns.map(r => r.name).join(', '), status: 'healing' });
          await delay(500); if (cancelled()) return;

          // Collect failed jobs + logs across ALL failing workflows
          setActiveNode('pipeline');
          const allJobsPerRun = await Promise.all(
            allFailedRuns.map(r => getRunJobs(effectivePat, owner, repoName, r.id)),
          );
          const allFailedJobs = allJobsPerRun.flat().filter(
            j => j.conclusion === 'failure' || j.conclusion === 'cancelled' || j.conclusion === 'timed_out',
          );
          track(r => ({
            ...r,
            failure: r.failure && {
              ...r.failure,
              jobs: allFailedJobs.map(j => j.name),
              steps: allFailedJobs.flatMap(j => j.steps.filter(st => st.conclusion === 'failure').map(st => st.name)),
            },
          }));
          if (allFailedJobs.length > 0) {
            const failedSteps = allFailedJobs.flatMap(j =>
              j.steps.filter(s => s.conclusion === 'failure' || s.conclusion === 'cancelled').map(s => s.name),
            );
            add({ type: 'info', message: `failed_jobs=${allFailedJobs.length} :: steps=[${failedSteps.slice(0, 5).join(', ')}]`, timestamp: ts() });
          }
          await delay(400); if (cancelled()) return;

          add({ type: 'attempt', message: `#1 :: strategy=fetch_workflow_files target=.github/workflows`, timestamp: ts() });
          setActiveNode('error-detection');
          const workflowFiles = await getWorkflowFiles(effectivePat, owner, repoName, branch);
          await delay(600); if (cancelled()) return;

          if (workflowFiles.length === 0) {
            add({ type: 'result', message: `execution_failed :: reason=no_workflow_files exit_code=1`, status: 'failure', timestamp: ts() });
            add({ type: 'decision', message: 'HALT_EXECUTION :: manual_intervention_required', timestamp: ts() });
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: 'no_workflow_files' });
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }
          add({ type: 'result', message: `files_fetched :: count=${workflowFiles.length} [${workflowFiles.map(f => f.path.split('/').pop()).join(', ')}]`, status: 'success', timestamp: ts() });
          await delay(300); if (cancelled()) return;

          // ── Static YAML semantic analysis ─────────────────────────────────────────────
          // Run before log-based diagnosis. Semantic bugs (wrong context keys, quoted expressions,
          // missing step IDs, cross-workflow collisions) produce no log output — they must be
          // detected by inspecting the workflow file content directly.
          add({ type: 'info', message: `STATIC_YAML_ANALYSIS :: scanning ${workflowFiles.length} workflow file(s) for semantic bugs`, timestamp: ts() });
          const staticFixes = applyRuleBasedFixes(
            ['invalid_workflow_syntax', 'yaml_syntax'] as ErrorCategory[],
            '',  // no logs — static analysis only
            workflowFiles,
          );
          const crossFileWarnings = crossFileConsistencyCheck(workflowFiles);
          if (!crossFileWarnings.consistent) {
            for (const w of crossFileWarnings.warnings) {
              add({ type: 'info', message: `CROSS_FILE_WARNING :: ${w}`, timestamp: ts() });
            }
          }
          if (staticFixes.length > 0) {
            add({ type: 'result', message: `STATIC_ANALYSIS_FIXES :: found ${staticFixes.length} semantic issue(s) without requiring logs`, status: 'success', timestamp: ts() });
          }
          // These will merge with any log-based fixes later

          interface FixWithSha { path: string; content: string; sha: string; explanation: string }
          let ghFixes: FixWithSha[] = [];
          let ghContextFiles: Array<{ path: string; content: string; sha?: string }> = [];
          let aiConfidence = 75;
          let aiAnalysis = '';
          let aiRankedAlternatives: Array<{ description: string; confidence: number; risk: string }> = [];
          let aiSources: Array<{ title: string; url: string }> = [];
          let fixStrategy: StrategyId = 'rules';
          let needsLockfileRefresh = false;
          const ghRuns: FailingRun[] = allFailedRuns.map(r => ({ id: r.id, name: r.name, workflowId: r.workflow_id, headSha: r.head_sha }));
          escalation = async () => {
            if (fixStrategy === 'revert') return;
            escalation = undefined; // once per run
            add({ type: 'attempt', message: 'ESCALATE :: fix branch still red after the deep pass — reverting to the last green build', timestamp: ts() });
            markStrategy('revert', 'active');
            const rev = await revertToLastGreen(strategyCtx('github', ghRuns, branch));
            if (rev.status === 'reverted' && rev.prUrl) {
              markStrategy('revert', 'done', `${rev.label}${rev.verified ? ' — CI green' : ''}`);
              add({ type: 'result', message: `REVERT_PR :: ${rev.label} — merge this instead of the fix PR`, status: 'success', url: rev.prUrl, timestamp: ts() });
            } else {
              markStrategy('revert', 'failed', rev.note ?? rev.status);
            }
          };

          add({ type: 'attempt', message: `#2 :: strategy=healing_ladder ai=${aiKey ? aiModel : 'none'}`, timestamp: ts() });
          setActiveNode('fix-engine');

          // Logs across ALL failing workflows (up to 5 jobs) — needed by every strategy
          const allGhJobLogs = await Promise.all(
            allFailedJobs.slice(0, 5).map(async j => {
              if (!j.id) return '';
              const raw = await getJobLogs(effectivePat, owner, repoName, j.id).catch(() => '');
              return `\nJob "${j.name}" logs:\n${chunkLogs(raw)}`;
            }),
          );
          const ghLogs = allGhJobLogs.join('\n');
          const allFailedStepNames = allFailedJobs.flatMap(j => j.steps.filter(s => s.conclusion === 'failure').map(s => s.name));
          const ghMultiDiag = categorizeAllErrors(ghLogs, allFailedStepNames);
          const ghDiagnosis = ghMultiDiag.primary;
          const ghAllCategories = ghMultiDiag.all.map(d => d.category);
          const ghClusters = clusterRootCauses(ghAllCategories);
          const ghCategoryLabel = ghMultiDiag.all.length > 1
            ? `${ghDiagnosis.category} (+${ghMultiDiag.all.length - 1} more: ${ghMultiDiag.all.slice(1).map(d => d.category).join(', ')})`
            : ghDiagnosis.category;
          track(r => ({ ...r, categories: ghAllCategories }));
          add({ type: 'info', message: `ERROR_DIAGNOSED :: categories=[${ghCategoryLabel}] :: ${ghDiagnosis.description}`, timestamp: ts() });
          if (ghClusters.some(c => c.categories.length > 1)) {
            add({ type: 'info', message: `ROOT_CAUSE_CLUSTER :: ${ghClusters.filter(c => c.categories.length > 1).map(c => `${c.rootCause}=[${c.categories.join('+')}]`).join(' | ')}`, timestamp: ts() });
          }

          const ghContext = await buildGithubContext(effectivePat, owner, repoName, branch, workflowFiles, ghMultiDiag.all, ghLogs);
          ghContextFiles = ghContext.allFiles;
          if (ghContext.additionalFiles.length > 0) {
            add({ type: 'info', message: `CONTEXT_EXPANDED :: fetched=[${ghContext.additionalFiles.map(f => f.path).join(', ')}]`, timestamp: ts() });
          }
          const ghFingerprint = detectFingerprint(ghContext.allFiles);
          add({ type: 'info', message: `REPO_FINGERPRINT :: ${ghFingerprint.summary}`, timestamp: ts() });

          const errorContext = sanitizeForAI([
            `Repository stack: ${ghFingerprint.summary}`,
            `Languages: [${ghFingerprint.languages.join(', ')}] Frameworks: [${ghFingerprint.frameworks.join(', ')}]`,
            `Failing workflows: ${allFailedRuns.map(r => `"${r.name}"`).join(', ')}`,
            `Commit: ${shortSha} — "${failedRun.head_commit?.message ?? ''}"`,
            `Failed jobs: ${allFailedJobs.map(j => j.name).join(', ') || 'none'}`,
            `Failed steps: ${allFailedStepNames.join(', ') || 'none'}`,
            ...allGhJobLogs.filter(Boolean),
          ].join('\n'));

          if (geminiKey) {
            const embedding = await getEmbedding(geminiKey, errorContext);
            const similar = embedding.length > 0 ? findSimilarFailure(embedding) : null;
            if (similar) {
              add({ type: 'info', message: `MEMORY_MATCH :: similar_failure_found ${timeAgoMs(similar.record.timestamp)} (${Math.round(similar.similarity * 100)}% match) — ${similar.record.fixes[0]?.explanation ?? 'see past fix'}`, timestamp: ts() });
            }
          }

          healSignature = errorSignature(ghLogs, ghAllCategories);
          const ghLadder = await runHealingLadder({
            ctx: strategyCtx('github', ghRuns, branch), repoKey, signature: healSignature,
            logs: ghLogs, categories: ghAllCategories, diagnoses: ghMultiDiag.all, files: ghContext.allFiles,
            staticFixes: staticFixes.map(f => withTargetSha(f, ghContext.allFiles)),
            errorContext, keys: { gemini: geminiKey, groq: groqKey, gcloud: gcloudKey },
            approvalThreshold: APPROVAL_THRESHOLD, requestApproval: approvalGate, onStrategy: markStrategy,
          });
          if (await finishLadder(ghLadder, ghEvent?.id ?? null)) return;
          if (ghLadder.kind === 'fixes') {
            ghFixes = ghLadder.fixes.map(f => ({ ...f, sha: f.sha ?? '' }));
            fixStrategy = ghLadder.strategy;
            needsLockfileRefresh = ghLadder.needsLockfileRefresh;
            aiConfidence = ghLadder.confidence;
            aiAnalysis = ghLadder.analysis;
            aiRankedAlternatives = ghLadder.alternatives;
            aiSources = ghLadder.sources;
            track(r => ({ ...withFixes(r, ghFixes, ghContext.allFiles, SOURCE_FOR[fixStrategy]), engine: fixStrategy, confidence: aiConfidence }));
          }
          await delay(300); if (cancelled()) return;

          // ── Merge static YAML analysis fixes ────────────────────────────────
          // staticFixes were computed before log-based diagnosis by inspecting YAML
          // content directly. They are pure rule-based fixes that need no log signal
          // and must be committed even when AI or rule-based paths produce nothing.
          if (staticFixes.length > 0) {
            const existingPaths = new Set(ghFixes.map(f => f.path));
            const allKnownFiles: Array<{ path: string; sha?: string }> = ghContextFiles.length > 0 ? ghContextFiles : workflowFiles;
            const staticWithSha: FixWithSha[] = staticFixes.map(f => withTargetSha(f, allKnownFiles));
            if (ghFixes.length === 0) {
              ghFixes = staticWithSha;
              track(r => ({ ...withFixes(r, staticWithSha, workflowFiles, 'static'), engine: 'static', confidence: 90 }));
              aiConfidence = 90;
              aiAnalysis = staticFixes.map(f => f.explanation).join('; ').substring(0, 500);
              add({
                type: 'result',
                message: `APPLYING_STATIC_FIXES :: committing ${staticFixes.length} semantic fix(es) — AI fallback produced no output`,
                status: 'success',
                timestamp: ts(),
              });
            } else {
              const newStatic = staticWithSha.filter(f => !existingPaths.has(f.path));
              if (newStatic.length > 0) {
                ghFixes = [...ghFixes, ...newStatic];
                track(r => withExtraFixes(r, newStatic, workflowFiles, 'static'));
                add({
                  type: 'info',
                  message: `MERGED_STATIC_FIXES :: added ${newStatic.length} additional semantic fix(es)`,
                  timestamp: ts(),
                });
              }
            }
          }

          // ── Fix safety validation ────────────────────────────────────────────
          track(r => withPhase(r, 'validate', 'active'));
          // Filter out malformed AI fixes (missing path/content) before validation
          ghFixes = ghFixes.filter(f => f.path && typeof f.path === 'string' && f.content && typeof f.content === 'string');
          if (ghFixes.length > 0) {
            const { safeFixes, results } = validateFixes(ghFixes, ghContextFiles);
            for (const r of results) {
              if (r.blocked.length > 0) {
                add({ type: 'info', message: `FIX_BLOCKED :: path=${r.path} :: ${r.blocked.join(' | ')}`, timestamp: ts() });
              }
              if (r.warnings.length > 0) {
                add({ type: 'info', message: `FIX_WARNING :: path=${r.path} :: ${r.warnings.join(' | ')}`, timestamp: ts() });
              }
            }
            const blocked = results.filter(r => !r.safe).length;
            if (blocked > 0) {
              add({ type: 'info', message: `VALIDATION :: ${safeFixes.length}/${ghFixes.length} fixes passed safety checks — ${blocked} blocked`, timestamp: ts() });
            }
            for (const res of results) {
              if (!res.safe) track(r => withFixStatus(r, res.path, 'blocked', res.blocked.join('; ')));
            }
            ghFixes = safeFixes;
          }

          if (ghFixes.length === 0) {
            add({ type: 'decision', message: 'HALT_EXECUTION :: no_fixes_available manual_intervention_required', timestamp: ts() });
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: 'no_fixes_generated' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }

          // ── Safe mode — analysis only, no branch/commit/PR ──────────────────
          if (safeMode) {
            add({ type: 'decision', message: `SAFE_MODE :: analysis_complete fixes_ready=${ghFixes.length} — skipping_apply`, timestamp: ts() });
            for (const f of ghFixes) {
              add({ type: 'info', message: `PROPOSED_FIX :: ${f.path} — ${f.explanation.substring(0, 80)}`, timestamp: ts() });
            }
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: `[SAFE_MODE] ${aiAnalysis || 'analysis_only'}`, confidence: aiConfidence });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, confidenceToLevel(aiConfidence, false));
            endRun();
            return;
          }

          // ── Check for an existing open aegis PR (iterative healing) ─────────────
          // If a previous healing cycle created a PR that CI still marks red,
          // resume from that branch instead of branching off main again.
          const existingAegisPR = await getOpenAegisPR(effectivePat, owner, repoName).catch(() => null);
          if (existingAegisPR) {
            const prBranchStatus = await waitForBranchCI(effectivePat, owner, repoName, existingAegisPR.branch, 5_000, 5_000);
            if (prBranchStatus === 'failure') {
              add({ type: 'info', message: `EXISTING_FIX_PR_DETECTED :: ${existingAegisPR.branch} — CI still red — resuming iterative healing`, timestamp: ts() });
              try {
                const resumeRuns = await getFailedRunsForBranch(effectivePat, owner, repoName, existingAegisPR.branch);
                if (resumeRuns.length > 0) {
                  const resumeJobsPerRun = await Promise.all(resumeRuns.map(r => getRunJobs(effectivePat, owner, repoName, r.id)));
                  const resumeFailedJobs = resumeJobsPerRun.flat().filter(j => j.conclusion === 'failure');
                  const resumeLogs = await Promise.all(resumeFailedJobs.slice(0, 5).map(async j => {
                    if (!j.id) return '';
                    const raw = await getJobLogs(effectivePat, owner, repoName, j.id).catch(() => '');
                    return `\nJob "${j.name}" logs:\n${chunkLogs(raw)}`;
                  }));
                  const resumeStepNames = resumeFailedJobs.flatMap(j => j.steps.filter(s => s.conclusion === 'failure').map(s => s.name));
                  const resumeDiag = categorizeAllErrors(resumeLogs.join('\n'), resumeStepNames);
                  add({ type: 'info', message: `RESUME_DIAGNOSIS :: categories=[${resumeDiag.all.map(d => d.category).join(', ')}]`, timestamp: ts() });
                  const resumeWorkflows = await getWorkflowFiles(effectivePat, owner, repoName, existingAegisPR.branch);
                  const resumeContext = await buildGithubContext(effectivePat, owner, repoName, existingAegisPR.branch, resumeWorkflows, resumeDiag.all, resumeLogs.join('\n'));
                  // Static analysis on the fix branch files
                  const resumeStaticFixes = applyRuleBasedFixes(
                    ['invalid_workflow_syntax', 'yaml_syntax'] as ErrorCategory[],
                    '', resumeWorkflows,
                  );
                  const resumeRuleFixes = applyRuleBasedFixes(resumeDiag.all.map(d => d.category), resumeLogs.join('\n'), resumeContext.allFiles);
                  const allResumeFixes = [...resumeStaticFixes, ...resumeRuleFixes];
                  const uniqueResumeFixes = allResumeFixes.filter((f, i, arr) => arr.findIndex(x => x.path === f.path) === i);
                  // Same safety gate as every other commit path
                  const { safeFixes: safeResumeFixes } = validateFixes(uniqueResumeFixes, resumeContext.allFiles);
                  if (safeResumeFixes.length > 0) {
                    add({ type: 'result', message: `RESUME_FIX :: found ${safeResumeFixes.length} additional fix(es) for existing PR branch`, status: 'success', timestamp: ts() });
                    track(r => withExtraFixes(r, safeResumeFixes, resumeContext.allFiles, 'resume'));
                    let resumeCommitted = 0;
                    for (const fix of safeResumeFixes) {
                      const target = withTargetSha(fix, resumeContext.allFiles);
                      const sha = await commitFile(effectivePat, owner, repoName, target.path, target.content, target.sha,
                        `fix(aegis-resume): ${fix.explanation.substring(0, 60)}`, existingAegisPR.branch);
                      await delay(300); if (cancelled()) return;
                      if (sha) {
                        resumeCommitted++;
                        add({ type: 'result', message: `fix_committed :: path=${target.path} → ${existingAegisPR.branch}`, status: 'success', timestamp: ts() });
                      } else {
                        add({ type: 'result', message: `commit_failed :: path=${target.path} → ${existingAegisPR.branch}`, status: 'failure', timestamp: ts() });
                      }
                    }
                    add({ type: 'info', message: `RESUME_COMPLETE :: committed ${resumeCommitted}/${safeResumeFixes.length} fix(es) to existing PR — PR: ${existingAegisPR.html_url}`, timestamp: ts() });
                  } else {
                    add({ type: 'info', message: `RESUME_DIAGNOSIS :: no_new_rule_fixes — existing failures require AI analysis or manual fix`, timestamp: ts() });
                  }
                }
              } catch { /* resume errors must not block the fresh healing cycle below */ }
            }
          }

          const fixBranch = `aegis/fix-${Date.now()}`;
          add({ type: 'attempt', message: `#3 :: strategy=create_branch name=${fixBranch}`, timestamp: ts() });
          const branchOk = await createBranch(effectivePat, owner, repoName, fixBranch, branch);
          await delay(500); if (cancelled()) return;

          if (!branchOk) {
            add({ type: 'result', message: `execution_failed :: reason=branch_creation_failed check_token_permissions`, status: 'failure', timestamp: ts() });
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: 'branch_creation_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }
          add({ type: 'result', message: `branch_created :: ${fixBranch}`, status: 'success', timestamp: ts() });
          await delay(300); if (cancelled()) return;

          let ghCommitted = 0;
          for (let i = 0; i < ghFixes.length; i++) {
            const fix = ghFixes[i];
            add({ type: 'attempt', message: `#${4 + i} :: strategy=commit_fix path=${fix.path}`, timestamp: ts() });
            const sha = await commitFile(effectivePat, owner, repoName, fix.path, fix.content, fix.sha, `fix(aegis): ${fix.explanation.substring(0, 60)}`, fixBranch);
            await delay(400); if (cancelled()) return;
            if (sha) {
              add({ type: 'result', message: `fix_committed :: sha=${sha.substring(0, 7)} path=${fix.path}`, status: 'success', timestamp: ts() });
              ghCommitted++;
            } else {
              add({ type: 'result', message: `commit_failed :: path=${fix.path} check_write_permissions`, status: 'failure', timestamp: ts() });
            }
          }

          if (ghCommitted === 0) {
            add({ type: 'decision', message: 'HALT_EXECUTION :: all_commits_failed', timestamp: ts() });
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: 'all_commits_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
            endRun();
            return;
          }

          if (needsLockfileRefresh) {
            await refreshLockfile('github', fixBranch, ghContextFiles,
              (path, content) => commitFile(effectivePat, owner, repoName, path, content, '', 'fix(aegis): regenerate lockfile', fixBranch).then(Boolean));
            if (cancelled()) return;
          }
          const prTitle = `fix(aegis): auto-fix CI failure via ${STRATEGY_NAME[fixStrategy]} [conf:${aiConfidence}%]`;
          add({ type: 'attempt', message: `#${4 + ghFixes.length} :: strategy=create_pull_request base=${branch}`, timestamp: ts() });
          const prBody = [
            `## AEGIS Auto-Fix`,
            ``,
            `> Generated by AEGIS autonomous healing system`,
            `> Strategy: **${STRATEGY_NAME[fixStrategy]}** · Confidence: **${aiConfidence}%**`,
            ``,
            `**Failed run:** ${failedRun.html_url}`,
            ``,
            `### Changes`,
            ...ghFixes.map(f => `- \`${f.path}\`: ${f.explanation}`),
            ``,
            `### Alternative Strategies Considered`,
            ...(aiRankedAlternatives.length > 0
              ? aiRankedAlternatives.map(a => `- [${a.confidence}% | risk:${a.risk}] ${a.description}`)
              : ['_None_']),
          ].join('\n');
          const prUrl = await createPR(effectivePat, owner, repoName, prTitle, prBody, fixBranch, branch);
          await delay(500); if (cancelled()) return;

          if (prUrl) {
            const recoveryTimeMs = Date.now() - healingStartRef.current;
            add({ type: 'result', message: `PR_CREATED :: confidence=${aiConfidence}% recovery=${Math.round(recoveryTimeMs / 1000)}s`, status: 'success', url: prUrl, timestamp: ts() });
            if (healSignature) rememberFix(repoKey, healSignature, ghFixes.map(f => ({ path: f.path, before: ghContextFiles.find(c => c.path === f.path)?.content ?? null, after: f.content, explanation: f.explanation })), false);
            if (ghEvent) await updateEvent(ghEvent.id, {
              status: 'healed',
              root_cause: aiAnalysis,
              fix_steps: ghFixes.map(f => f.explanation),
              confidence: aiConfidence,
              ranked_fixes: aiRankedAlternatives,
              sources: aiSources,
              recovery_time_ms: recoveryTimeMs,
            });
            onEventUpdated?.();
            setSystemStatus('healthy');
            onHealingComplete?.(project.id, confidenceToLevel(aiConfidence, true));

            if (geminiKey) {
              try {
                const errorContext = [
                  `Failed workflows: ${allFailedRuns.map(r => r.name).join(', ')}`,
                  `Commit: ${shortSha}`,
                  `Failed jobs: ${allFailedJobs.map(j => j.name).join(', ')}`,
                ].join('\n');
                const embedding = await getEmbedding(geminiKey, errorContext);
                saveFailure({
                  id: `${owner}-${repoName}-${failedRun.id}`,
                  repoName: `${owner}/${repoName}`,
                  errorContext,
                  fixes: ghFixes.map(f => ({ path: f.path, explanation: f.explanation })),
                  embedding,
                  timestamp: Date.now(),
                });
              } catch { /* memory save must not affect healing outcome */ }
            }

            // Verify fix by polling CI on the fix branch (non-blocking — max 60s)
            add({ type: 'attempt', message: `VERIFY_FIX :: polling_ci branch=${fixBranch} max_wait=60s`, timestamp: ts() });
            const ghCiVerify = await waitForBranchCI(effectivePat, owner, repoName, fixBranch, 60_000, 15_000);
            if (cancelled()) return;
            if (ghCiVerify === 'success') {
              add({ type: 'result', message: `FIX_VERIFIED :: ci_green branch=${fixBranch} — fix_confirmed_working`, status: 'success', timestamp: ts() });
            } else {
              // Timeout or red — determine final state before running deep diagnosis
              let deepDiagResult: 'success' | 'failure' | 'timeout' = ghCiVerify;
              if (ghCiVerify === 'timeout') {
                add({ type: 'info', message: `VERIFY_TIMEOUT :: ci_still_running after_60s — waiting_45s_for_jobs_to_complete`, timestamp: ts() });
                {
                  await delay(45_000); if (cancelled()) return;
                  deepDiagResult = await waitForBranchCI(effectivePat, owner, repoName, fixBranch, 45_000, 15_000);
                  if (cancelled()) return;
                  if (deepDiagResult === 'success') {
                    add({ type: 'result', message: `FIX_VERIFIED :: ci_green after extended wait — fix_confirmed_working`, status: 'success', timestamp: ts() });
                    deepDiagResult = 'success';
                  } else if (deepDiagResult === 'timeout') {
                    add({ type: 'info', message: `VERIFY_TIMEOUT :: ci_still_running after_105s — monitor_PR_directly`, timestamp: ts() });
                    deepDiagResult = 'success'; // mark as handled so deep diagnosis is skipped
                  }
                  // if 'failure', fall through to deep diagnosis below
                }
              }

              if (deepDiagResult === 'failure') {
              // CI is still red — run a deep second-pass diagnosis on the fix branch
              add({ type: 'result', message: `FIX_UNVERIFIED :: ci_red branch=${fixBranch} — starting deep_diagnosis_pass`, status: 'failure', timestamp: ts() });
              {
                try {
                  await delay(6_000); if (cancelled()) return;
                  add({ type: 'attempt', message: `DEEP_DIAGNOSIS :: fetching fix-branch CI logs for second pass`, timestamp: ts() });
                  const deepRuns = await getFailedRunsForBranch(effectivePat, owner, repoName, fixBranch);
                  if (deepRuns.length > 0) {
                    const deepJobsPerRun = await Promise.all(deepRuns.map(r => getRunJobs(effectivePat, owner, repoName, r.id)));
                    const deepFailedJobs = deepJobsPerRun.flat().filter(j => j.conclusion === 'failure');
                    const deepLogs = await Promise.all(
                      deepFailedJobs.slice(0, 5).map(async j => {
                        if (!j.id) return '';
                        const raw = await getJobLogs(effectivePat, owner, repoName, j.id).catch(() => '');
                        return `\nJob "${j.name}" logs:\n${chunkLogs(raw)}`;
                      }),
                    );
                    const deepStepNames = deepFailedJobs.flatMap(j =>
                      j.steps.filter(s => s.conclusion === 'failure').map(s => s.name),
                    );
                    const deepDiag = categorizeAllErrors(deepLogs.join('\n'), deepStepNames);
                    const deepCategories = deepDiag.all.map(d => d.category);
                    const deepCatLabel = deepCategories.length > 1
                      ? `${deepDiag.primary.category} (+${deepCategories.length - 1} more)`
                      : deepDiag.primary.category;
                    add({ type: 'info', message: `DEEP_DIAGNOSIS :: categories=[${deepCatLabel}] :: ${deepDiag.primary.description}`, timestamp: ts() });

                    // Fetch current state from the fix branch for accurate context + SHAs
                    const deepWorkflows = await getWorkflowFiles(effectivePat, owner, repoName, fixBranch);
                    const deepContext = await buildGithubContext(effectivePat, owner, repoName, fixBranch, deepWorkflows, deepDiag.all, deepLogs.join('\n'));

                    // Rule-based first, fall back to AI
                    interface DeepFix { path: string; content: string; explanation: string; sha: string }
                    let deepFixes: DeepFix[] = [];
                    const deepRuleFixes = applyRuleBasedFixes(deepCategories, deepLogs.join('\n'), deepContext.allFiles);
                    if (deepRuleFixes.length > 0) {
                      add({ type: 'result', message: `DEEP_FIX :: rule_match=${deepRuleFixes.length} patterns categories=[${deepCategories.slice(0, 3).join(', ')}]`, status: 'success', timestamp: ts() });
                      deepFixes = deepRuleFixes.map(f => withTargetSha(f, deepContext.allFiles));
                    } else {
                      const deepErrCtx = sanitizeForAI([
                        `SECOND-PASS: CI still red on fix branch after first fix was applied.`,
                        `Remaining failed jobs: ${deepFailedJobs.map(j => j.name).join(', ') || 'none'}`,
                        `Remaining failed steps: ${deepStepNames.join(', ') || 'none'}`,
                        ...deepLogs.filter(Boolean),
                      ].join('\n'));
                      let deepResult = gcloudKey ? await analyzeWithGrounding(gcloudKey, deepErrCtx, deepContext.allFiles) : null;
                      if (!deepResult || deepResult.fixes.length === 0) {
                        if (groqKey) deepResult = await analyzeAndFixWithGroq(groqKey, deepErrCtx, deepContext.allFiles, deepDiag.all);
                      }
                      if (!deepResult || deepResult.fixes.length === 0) {
                        if (geminiKey) deepResult = await analyzeAndFixWithGemini(geminiKey, deepErrCtx, deepContext.allFiles, deepDiag.primary);
                      }
                      if (deepResult && deepResult.fixes.length > 0) {
                        const short = deepResult.analysis.length > 80 ? deepResult.analysis.substring(0, 80) + '…' : deepResult.analysis;
                        add({ type: 'result', message: `DEEP_FIX :: ai conf=${deepResult.confidence}% :: ${short}`, status: 'success', timestamp: ts() });
                        deepFixes = deepResult.fixes.map(f => withTargetSha(f, deepContext.allFiles));
                      }
                    }

                    // Validate + commit deep fixes to the existing fix branch
                    deepFixes = deepFixes.filter(f => f.path && typeof f.path === 'string' && f.content && typeof f.content === 'string');
                    if (deepFixes.length > 0) {
                      const { safeFixes: deepSafe } = validateFixes(deepFixes, deepContext.allFiles);
                      track(r => withExtraFixes(r, deepSafe, deepContext.allFiles, 'deep'));
                      let deepCommitted = 0;
                      for (const fix of deepSafe) {
                        track(r => withFixStatus(r, fix.path, 'committing'));
                        const sha = await commitFile(effectivePat, owner, repoName, fix.path, fix.content, fix.sha,
                          `fix(aegis-deep): ${fix.explanation.substring(0, 60)}`, fixBranch);
                        await delay(300); if (cancelled()) return;
                        track(r => withFixStatus(r, fix.path, sha ? 'committed' : 'failed'));
                        if (sha) deepCommitted++;
                      }
                      if (deepCommitted > 0) {
                        add({ type: 'info', message: `DEEP_FIX :: committed=${deepCommitted} to ${fixBranch} — re-checking CI max_wait=90s`, timestamp: ts() });
                        const deepVerify = await waitForBranchCI(effectivePat, owner, repoName, fixBranch, 90_000, 15_000);
                        if (cancelled()) return;
                        if (deepVerify === 'success') {
                          add({ type: 'result', message: `FIX_VERIFIED :: ci_green after deep diagnosis pass`, status: 'success', timestamp: ts() });
                        } else if (deepVerify === 'failure') {
                          add({ type: 'result', message: `DEEP_UNVERIFIED :: ci_red after 2 passes — see PR for manual investigation`, status: 'failure', timestamp: ts() });
                          await escalation?.();
                        } else {
                          add({ type: 'info', message: `DEEP_VERIFY_TIMEOUT :: ci_still_running — monitor PR directly`, timestamp: ts() });
                        }
                      } else {
                        add({ type: 'info', message: `DEEP_FIX :: no_new_commits — all additional fixes blocked by validator or already applied`, timestamp: ts() });
                        await escalation?.();
                      }
                    } else {
                      add({ type: 'info', message: `DEEP_DIAGNOSIS :: no_additional_fixes_found — remaining failures require manual intervention`, timestamp: ts() });
                      await escalation?.();
                    }
                  } else {
                    add({ type: 'info', message: `DEEP_DIAGNOSIS :: no_failed_runs_on_branch_yet — CI may still be initializing`, timestamp: ts() });
                  }
                } catch { /* deep pass must not affect the PR already created */ }
              }
              } // end if (deepDiagResult === 'failure')
            }
          } else {
            add({ type: 'result', message: `pr_creation_failed :: branch=${fixBranch} exists with commits`, status: 'failure', timestamp: ts() });
            if (ghEvent) await updateEvent(ghEvent.id, { status: 'failed', root_cause: 'pr_creation_failed' });
            onEventUpdated?.();
            setSystemStatus('stopped');
            onHealingComplete?.(project.id, 'HIGH');
          }
        }

      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown_error';
        // Don't leave the history entry stuck at 'healing' forever.
        if (trackedEventId !== null && !eventFinalized) {
          await updateEvent(trackedEventId, { status: 'failed', root_cause: `error: ${reason}`.substring(0, 500) });
          onEventUpdated?.();
        }
        if (!cancelled()) {
          add({ type: 'decision', message: `ERROR :: ${reason}`, timestamp: ts() });
          setSystemStatus('stopped');
          onHealingComplete?.(project.id, 'HIGH');
        }
      }

      endRun();
      return;
    }

    // ── DEMO MODE ────────────────────────────────────────────────────────────────
    // No repo/PAT: replay a healing run against a sample broken workflow. The
    // fixes shown are produced by the REAL rule engine, so the diff view in the
    // UI is genuine output — only the GitHub calls (branch/commit/PR) are simulated.
    const demoFiles = [{
      path: '.github/workflows/ci.yml',
      content: [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v2',
        '      - uses: actions/setup-node@v2',
        '        with:',
        "          node-version: '16'",
        '      - run: npm ci',
        '      - run: npm test',
        '',
      ].join('\n'),
    }];
    const demoLogs = 'Warning: Node.js 16 actions are deprecated. Please update the following actions to use Node.js 20: actions/checkout@v2, actions/setup-node@v2';
    const demoCategories: ErrorCategory[] = ['actions_deprecation', 'node_version'];
    const demoFixes = applyRuleBasedFixes(demoCategories, demoLogs, demoFiles);
    const { safeFixes: demoSafe, results: demoResults } = validateFixes(demoFixes, demoFiles);

    const steps: Array<[number, () => void]> = [
      [400, () => add({ type: 'info', message: 'fetching_workflow_runs :: status=failure (demo repository)', timestamp: ts() })],
      [1200, () => {
        setActiveNode('pipeline');
        add({ type: 'detected', message: 'ci_failure :: workflows=1 [CI] commit=a3f4b2c', timestamp: ts() });
        track(r => ({ ...r, failure: { workflows: ['CI'], jobs: ['build'], steps: ['Run actions/setup-node@v2'], sha: 'a3f4b2c' } }));
      }],
      [2000, () => { setActiveNode('error-detection'); add({ type: 'attempt', message: '#1 :: strategy=fetch_workflow_files target=.github/workflows', timestamp: ts() }); }],
      [2800, () => { track(r => withPhase(r, 'diagnose', 'active')); add({ type: 'info', message: `LOGS :: ${demoLogs.substring(0, 90)}…`, timestamp: ts() }); }],
      [3600, () => {
        setActiveNode('fix-engine');
        track(r => ({ ...r, categories: demoCategories }));
        add({ type: 'info', message: `ERROR_DIAGNOSED :: categories=[${demoCategories.join(', ')}] :: deprecated action runtimes`, timestamp: ts() });
      }],
      [4600, () => {
        track(r => ({ ...withFixes(r, demoFixes, demoFiles, 'rule'), engine: 'rules', confidence: 95 }));
        add({ type: 'result', message: `RULE_BASED_FIX :: matched=${demoFixes.length} file(s) confidence=95%`, status: 'success', timestamp: ts() });
      }],
      [5400, () => {
        track(r => withPhase(r, 'validate', 'active'));
        for (const res of demoResults) if (!res.safe) track(r => withFixStatus(r, res.path, 'blocked', res.blocked.join('; ')));
        add({ type: 'info', message: `VALIDATION :: ${demoSafe.length}/${demoFixes.length} fixes passed safety checks`, timestamp: ts() });
      }],
      [6200, () => add({ type: 'attempt', message: '#3 :: strategy=create_branch name=aegis/fix-demo', timestamp: ts() })],
      ...demoSafe.flatMap((f, i): Array<[number, () => void]> => [
        [7000 + i * 900, () => add({ type: 'attempt', message: `#${4 + i} :: strategy=commit_fix path=${f.path}`, timestamp: ts() })],
        [7500 + i * 900, () => add({ type: 'result', message: `fix_committed :: sha=demo${i} path=${f.path} (simulated)`, status: 'success', timestamp: ts() })],
      ]),
      [7800 + demoSafe.length * 900, () => add({ type: 'attempt', message: '#9 :: strategy=create_pull_request base=main (simulated)', timestamp: ts() })],
      [8600 + demoSafe.length * 900, () => {
        add({ type: 'result', message: 'PR_CREATED :: confidence=95% (simulated — connect a repo + PAT to open real PRs)', status: 'success', timestamp: ts() });
        setActiveNode('validation');
        add({ type: 'attempt', message: 'VERIFY_FIX :: polling_ci branch=aegis/fix-demo (simulated)', timestamp: ts() });
      }],
      [10600 + demoSafe.length * 900, () => {
        add({ type: 'result', message: 'FIX_VERIFIED :: ci_green branch=aegis/fix-demo (simulated)', status: 'success', timestamp: ts() });
        track(r => withOutcome(r, 'healed', 'Demo run — fixes produced by the real rule engine; branch, commits and PR were simulated'));
        setSystemStatus('healthy');
        endRun();
      }],
    ];

    for (const [d, step] of steps) {
      setTimeout(() => { if (!cancelled()) step(); }, d);
    }
  };

  return {
    systemStatus,
    setSystemStatus,
    activeNode,
    setActiveNode,
    streamEntries,
    logs,
    showLogs,
    setShowLogs,
    healRepo,
    isHealing: () => healingRef.current,
    resetHealing,
    pendingApproval,
    approveHealing,
    cancelHealing,
    run,
  };
}
