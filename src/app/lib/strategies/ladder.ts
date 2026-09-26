// The healing ladder: every strategy is a backup for the one before it,
// ordered from most useful + cheapest + safest to last resort.
//
//   1. memory   replay a fix that already turned this exact error green   instant, proven
//   2. rules    deterministic rules + compiler "did you mean" suggestions  instant, no AI
//               (+ exact dependency versions from npm / PyPI)
//   3. flaky    re-run only the failed jobs; green → change nothing       one CI rerun
//               (runs FIRST when every diagnosed cause is transient)
//   4. autofix  the repo's own eslint --fix / prettier / ruff / black /   one CI job
//               gofmt / clippy --fix / dotnet format / lockfile refresh
//   5. ai       grounded Gemini → Groq → Gemini (refuses partially-seen files; approval gate)
//   6. revert   revert to the last green build, candidates validated on CI  last resort
//
// Each step's result goes through the same safety validator before anything is committed.

import { applyRuleBasedFixes } from '../ruleBasedFixer';
import type { ErrorCategory, ErrorDiagnosis } from '../diagnostics';
import { computeRuleConfidence, crossFileConsistencyCheck, getAlternativeStrategies } from '../fixEngine';
import { analyzeWithGrounding } from '../vertexai';
import { analyzeAndFixWithGroq } from '../groq';
import { analyzeAndFixWithGemini } from '../gemini';
import { findKnownFix } from './knownFixes';
import { checkFlaky, looksTransient } from './flaky';
import { runAutofixJob } from './autofixJob';
import { revertToLastGreen } from './revert';
import { pinResolvedVersions, changesNpmDependencies } from './versions';
import type { ProposedFix, RepoFile, StrategyContext, StrategyId } from './types';

export type StrategyState = 'active' | 'done' | 'failed' | 'skipped';
export interface Alternative { description: string; confidence: number; risk: string }

export interface LadderInput {
  ctx: StrategyContext;
  repoKey: string;                  // owner/repo
  signature: string;                // errorSignature(logs, categories)
  logs: string;
  categories: ErrorCategory[];
  diagnoses: ErrorDiagnosis[];
  files: RepoFile[];                // context files (with blob sha on GitHub)
  staticFixes?: ProposedFix[];      // GitHub static YAML analysis — counts as rules
  errorContext: string;
  keys: { gemini: string; groq: string; gcloud: string };
  approvalThreshold: number;
  requestApproval: (a: { confidence: number; analysis: string; fixes: Array<{ path: string; explanation: string }>; alternatives: Alternative[] }) => Promise<boolean>;
  onStrategy: (id: StrategyId, state: StrategyState, note?: string) => void;
}

export type LadderResult =
  | { kind: 'fixes'; strategy: StrategyId; fixes: ProposedFix[]; confidence: number; analysis: string; alternatives: Alternative[]; sources: Array<{ title: string; url: string }>; needsLockfileRefresh: boolean }
  | { kind: 'flaky' }
  | { kind: 'reverted'; prUrl: string; label: string; verified: boolean }
  | { kind: 'rejected'; confidence: number; analysis: string }
  | { kind: 'none'; reason: string }
  | { kind: 'cancelled' };

const withSha = (fix: { path: string; content: string; explanation: string }, files: RepoFile[]): ProposedFix => {
  const exact = files.find(f => f.path === fix.path);
  if (exact) return { ...fix, sha: exact.sha ?? '' };
  const bySuffix = files.filter(f => f.path.endsWith(`/${fix.path}`));
  return bySuffix.length === 1 ? { ...fix, path: bySuffix[0].path, sha: bySuffix[0].sha ?? '' } : { ...fix, sha: '' };
};

export async function runHealingLadder(input: LadderInput): Promise<LadderResult> {
  const { ctx, files, categories, onStrategy: mark } = input;
  const log = ctx.log;
  const cancelled = () => ctx.isCancelled();
  let flakyChecked = false;

  const flakyStep = async (): Promise<LadderResult | null> => {
    flakyChecked = true;
    mark('flaky', 'active');
    const r = await checkFlaky(ctx);
    if (cancelled()) return { kind: 'cancelled' };
    if (r === 'flaky') {
      mark('flaky', 'done', 'passed on rerun — no code change needed');
      log('FLAKY :: failed jobs passed on rerun — the code is fine, nothing to change', 'ok');
      return { kind: 'flaky' };
    }
    mark('flaky', r === 'unavailable' ? 'skipped' : 'failed', r === 'unavailable' ? 'rerun not available' : 'still fails on rerun — a real failure');
    return null;
  };

  // ── 1. Replay a proven fix ────────────────────────────────────────────────
  mark('memory', 'active');
  const known = findKnownFix(input.repoKey, input.signature, files);
  if (known) {
    mark('memory', 'done', `stored fix from ${new Date(known.savedAt).toLocaleDateString()}${known.verified ? ' (CI was green)' : ''}`);
    log(`KNOWN_FIX :: replaying a fix that ${known.verified ? 'turned CI green' : 'was applied'} for this exact error — files unchanged since`, 'ok');
    return { kind: 'fixes', strategy: 'memory', fixes: known.fixes, confidence: known.verified ? 97 : 85, analysis: 'Replayed a previously successful fix for the identical error', alternatives: [], sources: [], needsLockfileRefresh: changesNpmDependencies(known.fixes, files) };
  }
  mark('memory', 'skipped', 'no stored fix for this error');

  // ── (3 first) transient failures: check flakiness before changing code ──
  if (looksTransient(categories)) {
    log(`TRANSIENT_DIAGNOSIS :: [${categories.join(', ')}] — checking for a flaky failure before changing code`, 'info');
    const r = await flakyStep();
    if (r) return r;
  }

  // ── 2. Deterministic rules + compiler suggestions ────────────────────────
  mark('rules', 'active');
  const allUnknown = categories.every(c => c === 'unknown');
  const ruleFixes = allUnknown ? [] : applyRuleBasedFixes(categories, input.logs, files);
  const merged = [...ruleFixes];
  for (const s of input.staticFixes ?? []) if (!merged.some(f => f.path === s.path)) merged.push({ ...s, confidence: 90 });
  if (merged.length > 0) {
    const pinned = await pinResolvedVersions(merged.map(f => withSha(f, files)), files);
    if (pinned.pinned.length) log(`EXACT_VERSIONS :: resolved from the registry — ${pinned.pinned.join(', ')}`, 'ok');
    if (pinned.unresolved.length) log(`EXACT_VERSIONS :: could not resolve ${pinned.unresolved.join(', ')} — left as-is, pin before merging`, 'info');
    const confidence = ruleFixes.length ? computeRuleConfidence(categories, ruleFixes.length) : 90;
    const alternatives = confidence < 90 ? getAlternativeStrategies(categories).slice(0, 3).map(s => ({ description: s.description, confidence: s.confidence, risk: s.risk })) : [];
    const consistency = crossFileConsistencyCheck(merged);
    for (const w of consistency.warnings) log(`CONSISTENCY_WARNING :: ${w}`, 'info');
    log(`RULE_BASED_FIX :: matched=${merged.length} file(s) categories=[${categories.slice(0, 3).join(', ')}] confidence=${confidence}%`, 'ok');
    mark('rules', 'done', `${merged.length} file(s)`);
    return {
      kind: 'fixes', strategy: 'rules', fixes: pinned.fixes, confidence,
      analysis: `[${categories.join('+')}] ${merged.map(f => f.explanation.split(' — ')[0]).join('; ')}`.substring(0, 500),
      alternatives, sources: [], needsLockfileRefresh: changesNpmDependencies(pinned.fixes, files),
    };
  }
  mark('rules', 'failed', allUnknown ? 'error not recognised by any rule' : 'no rule matched these files');

  // ── 3. Flaky check ───────────────────────────────────────────────────────
  if (!flakyChecked) {
    const r = await flakyStep();
    if (r) return r;
  }
  if (cancelled()) return { kind: 'cancelled' };

  // ── 4. The project's own auto-fixers, run in CI ─────────────────────────
  mark('autofix', 'active');
  log('AUTOFIX_JOB :: running the repo\'s own formatters/linters in a temporary CI job', 'attempt');
  const auto = await runAutofixJob(ctx, ctx.branch, files, 'full');
  if (cancelled()) return { kind: 'cancelled' };
  if (auto.status === 'ok') {
    const fixes = auto.changed.map(c => withSha({ path: c.path, content: c.content, explanation: `Applied by the project's own tools (${auto.tools.join(', ')}) using the repo's config` }, files));
    log(`AUTOFIX_JOB :: ${auto.tools.join(', ')} changed ${fixes.length} file(s)`, 'ok');
    mark('autofix', 'done', `${auto.tools.join(', ')} → ${fixes.length} file(s)`);
    return { kind: 'fixes', strategy: 'autofix', fixes, confidence: 88, analysis: `Project's own fixers (${auto.tools.join(', ')}) resolved the reported issues`, alternatives: [], sources: [], needsLockfileRefresh: false };
  }
  const autoNote = { 'no-tools': 'no fixer tools configured in this repo', 'no-changes': `ran ${auto.tools.join(', ') || 'tools'} — nothing to change`, unavailable: auto.note ?? 'unavailable', timeout: 'job did not finish in time', failed: auto.note ?? 'job failed' }[auto.status];
  mark('autofix', auto.status === 'no-tools' ? 'skipped' : 'failed', autoNote);
  log(`AUTOFIX_JOB :: ${autoNote}`, 'info');

  // ── 5. AI (last resort before reverting) ─────────────────────────────────
  const { gemini, groq, gcloud } = input.keys;
  if (gemini || groq || gcloud) {
    mark('ai', 'active');
    let result = gcloud ? await analyzeWithGrounding(gcloud, input.errorContext, files) : null;
    if ((!result || result.fixes.length === 0) && groq) result = await analyzeAndFixWithGroq(groq, input.errorContext, files, input.diagnoses);
    if ((!result || result.fixes.length === 0) && gemini) result = await analyzeAndFixWithGemini(gemini, input.errorContext, files, input.diagnoses[0]);
    if (cancelled()) return { kind: 'cancelled' };
    if (result?.refusedPartial?.length) log(`AI_GUARD :: refused rewrites of ${result.refusedPartial.join(', ')} — the model only saw part of ${result.refusedPartial.length > 1 ? 'those files' : 'that file'}`, 'info');
    if (result && result.fixes.length > 0) {
      const fixes = result.fixes.map(f => withSha(f, files));
      const alternatives = result.ranked_alternatives ?? [];
      const sources = (result as { sources?: Array<{ title: string; url: string }> }).sources ?? [];
      log(`ai_analysis_complete :: confidence=${result.confidence}% :: ${result.analysis.substring(0, 90)}`, 'ok');
      if (sources.length) log(`GROUNDING_SOURCES :: ${sources.slice(0, 3).map(s => s.title.substring(0, 45)).join(' | ')}`, 'info');
      if (result.confidence < input.approvalThreshold) {
        log(`LOW_CONFIDENCE :: score=${result.confidence}% threshold=${input.approvalThreshold}% :: awaiting_operator_approval`, 'info');
        const approved = await input.requestApproval({ confidence: result.confidence, analysis: result.analysis, fixes: fixes.map(f => ({ path: f.path, explanation: f.explanation })), alternatives });
        if (cancelled()) return { kind: 'cancelled' };
        if (!approved) { mark('ai', 'failed', 'operator rejected the low-confidence fix'); return { kind: 'rejected', confidence: result.confidence, analysis: result.analysis }; }
        log(`APPROVAL_GRANTED :: proceeding_with_confidence=${result.confidence}%`, 'ok');
      }
      mark('ai', 'done', `confidence ${result.confidence}%`);
      return { kind: 'fixes', strategy: 'ai', fixes, confidence: result.confidence, analysis: result.analysis, alternatives, sources, needsLockfileRefresh: changesNpmDependencies(fixes, files) };
    }
    mark('ai', 'failed', 'no usable fix from the models');
    log('ai_analysis_failed :: reason=no_fixes_generated', 'fail');
  } else {
    mark('ai', 'skipped', 'no AI key configured');
  }

  // ── 6. Revert to the last green build ───────────────────────────────────
  mark('revert', 'active');
  log('REVERT :: every other strategy failed — looking for the change that broke CI', 'attempt');
  const rev = await revertToLastGreen(ctx);
  if (cancelled()) return { kind: 'cancelled' };
  if (rev.status === 'reverted' && rev.prUrl) {
    mark('revert', 'done', `${rev.label}${rev.verified ? ' — CI green' : ' — unverified'}`);
    return { kind: 'reverted', prUrl: rev.prUrl, label: rev.label ?? 'revert', verified: !!rev.verified };
  }
  mark('revert', rev.status === 'no-green' || rev.status === 'no-candidates' ? 'skipped' : 'failed', rev.note ?? rev.status);
  return { kind: 'none', reason: rev.note ?? 'no strategy produced a fix' };
}
