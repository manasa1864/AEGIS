// Strategy 6 — revert to the last green build (last resort; also the escalation
// when a fix's own CI stays red after the deep second pass).
//
// Finds the newest successful run on the failing branch, lists the commits
// since, and builds candidate reverts — each recent commit on its own (newest
// first), plus "restore every changed file to its last-green state". Every
// candidate is pushed to its own branch and validated by CI in parallel; the
// first one that goes green becomes the PR. This is candidate-patch validation
// (try fixes, keep the one that passes) with reverts as the candidates.

import {
  getLastGreenRun, compareCommits as ghCompare, getCommitFiles, getTreeEntries, createBranchWithCommit,
  getBranchSha, waitForBranchCI, deleteBranch as ghDeleteBranch, createPR,
  type TreeEntry, type ChangedFile,
} from '../github';
import {
  getLastGreenPipeline, compareCommits as glCompare, createBranch as glCreateBranch, revertCommit,
  waitForBranchPipeline, deleteBranch as glDeleteBranch, createMR, getBranchHead,
} from '../gitlab';
import type { StrategyContext } from './types';

export interface RevertResult {
  status: 'reverted' | 'no-green' | 'no-candidates' | 'none-passed' | 'unavailable';
  prUrl?: string;
  branch?: string;
  label?: string;
  verified?: boolean;
  lastGreen?: string;
  note?: string;
}

interface Candidate { label: string; commits: Array<{ sha: string; message: string }>; branch?: string }

const short = (sha: string) => sha.slice(0, 7);

function describePR(c: Candidate, lastGreen: string, verified: boolean): string {
  return [
    '## AEGIS — revert to last green build',
    '',
    `CI on this branch was green at \`${short(lastGreen)}\`. The change${c.commits.length > 1 ? 's' : ''} below broke it:`,
    '',
    ...c.commits.map(x => `- \`${short(x.sha)}\` ${x.message}`),
    '',
    verified
      ? '✅ CI passed on this revert before the PR was opened (candidates were validated in parallel; this is the first that went green).'
      : '⚠️ CI does not run on temporary branches in this repo, so this revert could not be validated beforehand — CI will run on this PR.',
    '',
    'All deterministic rules, the project\'s own auto-fixers and AI analysis were tried first. Re-apply the reverted change once it is fixed.',
  ].join('\n');
}

export async function revertToLastGreen(ctx: StrategyContext, maxWaitMs = 12 * 60_000, maxSingleCandidates = 3): Promise<RevertResult> {
  return ctx.platform === 'github' ? revertGithub(ctx, maxWaitMs, maxSingleCandidates) : revertGitlab(ctx, maxWaitMs, maxSingleCandidates);
}

async function revertGithub(ctx: StrategyContext, maxWaitMs: number, maxSingle: number): Promise<RevertResult> {
  const { pat, owner, repo, branch } = ctx;
  const run = ctx.failingRuns[0];
  const badSha = run?.headSha ?? await getBranchSha(pat, owner, repo, branch);
  if (!badSha) return { status: 'unavailable', note: 'could not resolve the failing commit' };
  const green = await getLastGreenRun(pat, owner, repo, branch, run?.workflowId);
  const goodSha = green?.head_sha;
  if (!goodSha) return { status: 'no-green', note: `no successful run on ${branch} to go back to` };
  if (goodSha === badSha) return { status: 'no-candidates', note: 'the last green run is on the same commit — the failure is not caused by a code change (try the flaky check)' };

  const cmp = await ghCompare(pat, owner, repo, goodSha, badSha);
  if (!cmp || cmp.commits.length === 0) return { status: 'no-candidates', lastGreen: goodSha };
  const newestFirst = [...cmp.commits].reverse();
  ctx.log(`REVERT :: last_green=${short(goodSha)} failing=${short(badSha)} — ${newestFirst.length} commit(s) in between`, 'info');

  const goodTree = await getTreeEntries(pat, owner, repo, goodSha);
  if (!goodTree) return { status: 'unavailable', note: 'repository tree too large to restore safely' };

  const restore = (files: ChangedFile[], tree: Map<string, TreeEntry>) => files.flatMap(f => {
    if (f.status === 'renamed' && f.previousPath) return [{ path: f.path, entry: null }, { path: f.previousPath, entry: tree.get(f.previousPath) ?? null }];
    return [{ path: f.path, entry: f.status === 'added' ? null : tree.get(f.path) ?? null }];
  });

  // Candidates, in preference order: newest single commits first, then the whole range.
  const candidates: Array<Candidate & { changes: Array<{ path: string; entry: TreeEntry | null }> }> = [];
  if (newestFirst.length > 1) {
    const touchedLater = new Set<string>();
    for (const c of newestFirst.slice(0, maxSingle)) {
      const files = await getCommitFiles(pat, owner, repo, c.sha);
      const paths = files.flatMap(f => [f.path, f.previousPath].filter(Boolean) as string[]);
      const overlaps = paths.some(p => touchedLater.has(p));
      paths.forEach(p => touchedLater.add(p));
      if (overlaps || files.length === 0 || files.length > 100 || !c.parent) continue; // can't restore cleanly
      const parentTree = await getTreeEntries(pat, owner, repo, c.parent);
      if (!parentTree) continue;
      candidates.push({ label: `revert ${short(c.sha)}`, commits: [c], changes: restore(files, parentTree) });
    }
  }
  candidates.push({ label: `revert ${newestFirst.length} commit(s) back to ${short(goodSha)}`, commits: newestFirst, changes: restore(cmp.files, goodTree) });

  const stamp = Date.now();
  for (const [i, c] of candidates.entries()) {
    const name = `aegis/revert-${stamp}-${i + 1}`;
    const msg = `revert(aegis): ${c.commits.length === 1 ? c.commits[0].message : `${c.commits.length} commits since last green ${short(goodSha)}`}`;
    if (await createBranchWithCommit(pat, owner, repo, name, badSha, c.changes, msg)) c.branch = name;
  }
  const live = candidates.filter(c => c.branch);
  if (live.length === 0) return { status: 'unavailable', lastGreen: goodSha, note: 'could not create candidate branches (token needs contents: write)' };
  ctx.log(`REVERT_CANDIDATES :: validating ${live.length} candidate(s) on CI in parallel — ${live.map(c => c.label).join(' | ')}`, 'attempt');

  const results = await Promise.all(live.map(c => waitForBranchCI(pat, owner, repo, c.branch!, maxWaitMs, 20_000)));
  let winner = live.find((_, i) => results[i] === 'success');
  const verified = !!winner;
  // CI never ran on the temp branches (workflows filtered to main) → open the full-range revert unvalidated.
  if (!winner && results.every(r => r === 'timeout')) winner = live[live.length - 1];
  for (const c of live) if (c !== winner) await ghDeleteBranch(pat, owner, repo, c.branch!);
  if (!winner) return { status: 'none-passed', lastGreen: goodSha, note: 'no revert candidate made CI green — the failure is likely environmental' };

  const prUrl = await createPR(pat, owner, repo, `revert(aegis): ${winner.label} — restores green CI`, describePR(winner, goodSha, verified), winner.branch!, branch);
  if (!prUrl) return { status: 'unavailable', lastGreen: goodSha, branch: winner.branch, note: 'revert branch created but the PR could not be opened' };
  return { status: 'reverted', prUrl, branch: winner.branch, label: winner.label, verified, lastGreen: goodSha };
}

async function revertGitlab(ctx: StrategyContext, maxWaitMs: number, maxSingle: number): Promise<RevertResult> {
  const { pat, owner, repo, branch } = ctx;
  const badSha = ctx.failingRuns[0]?.headSha ?? await getBranchHead(pat, owner, repo, branch);
  if (!badSha) return { status: 'unavailable', note: 'could not resolve the failing commit' };
  const goodSha = (await getLastGreenPipeline(pat, owner, repo, branch))?.sha;
  if (!goodSha) return { status: 'no-green', note: `no successful pipeline on ${branch} to go back to` };
  if (goodSha === badSha) return { status: 'no-candidates', note: 'the last green pipeline is on the same commit — not caused by a code change' };
  const cmp = await glCompare(pat, owner, repo, goodSha, badSha);
  if (!cmp || cmp.commits.length === 0) return { status: 'no-candidates', lastGreen: goodSha };
  const newestFirst = cmp.commits;
  ctx.log(`REVERT :: last_green=${short(goodSha)} failing=${short(badSha)} — ${newestFirst.length} commit(s) in between`, 'info');

  const candidates: Candidate[] = [
    ...(newestFirst.length > 1 ? newestFirst.slice(0, maxSingle).map(c => ({ label: `revert ${short(c.sha)}`, commits: [c] })) : []),
    { label: `revert ${newestFirst.length} commit(s) back to ${short(goodSha)}`, commits: newestFirst },
  ];
  const stamp = Date.now();
  for (const [i, c] of candidates.entries()) {
    const name = `aegis/revert-${stamp}-${i + 1}`;
    if (!await glCreateBranch(pat, owner, repo, name, badSha)) continue;
    let ok = true;
    for (const commit of c.commits) { // newest first — GitLab's revert is a real 3-way revert
      if (!await revertCommit(pat, owner, repo, commit.sha, name)) { ok = false; break; }
    }
    if (ok) c.branch = name;
    else await glDeleteBranch(pat, owner, repo, name); // conflicting revert — drop this candidate
  }
  const live = candidates.filter(c => c.branch);
  if (live.length === 0) return { status: 'unavailable', lastGreen: goodSha, note: 'every revert conflicted or branch creation failed' };
  ctx.log(`REVERT_CANDIDATES :: validating ${live.length} candidate(s) on CI in parallel — ${live.map(c => c.label).join(' | ')}`, 'attempt');

  const results = await Promise.all(live.map(c => waitForBranchPipeline(pat, owner, repo, c.branch!, maxWaitMs, 20_000)));
  let winner = live.find((_, i) => results[i] === 'success');
  const verified = !!winner;
  if (!winner && results.every(r => r === 'timeout')) winner = live[live.length - 1];
  for (const c of live) if (c !== winner) await glDeleteBranch(pat, owner, repo, c.branch!);
  if (!winner) return { status: 'none-passed', lastGreen: goodSha, note: 'no revert candidate made CI green — the failure is likely environmental' };

  const url = await createMR(pat, owner, repo, `revert(aegis): ${winner.label} — restores green CI`, describePR(winner, goodSha, verified), winner.branch!, branch);
  if (!url) return { status: 'unavailable', lastGreen: goodSha, branch: winner.branch, note: 'revert branch created but the MR could not be opened' };
  return { status: 'reverted', prUrl: url, branch: winner.branch, label: winner.label, verified, lastGreen: goodSha };
}
