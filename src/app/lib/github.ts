import { b64DecodeUtf8, b64EncodeUtf8 } from './base64';

export interface RepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  description: string;
  isPrivate: boolean;
  stars: number;
  forks: number;
  language: string;
  openIssues: number;
}

export interface WorkflowRun {
  id: number;
  workflow_id?: number;
  name: string;
  status: string;
  conclusion: string;
  html_url: string;
  created_at: string;
  head_sha?: string;
  head_branch?: string;
  head_commit: { message: string; id: string };
}

export interface WorkflowJob {
  id: number;
  name: string;
  conclusion: string;
  startedAt?: string;
  completedAt?: string;
  steps: Array<{ name: string; conclusion: string | null; number: number; startedAt?: string; completedAt?: string }>;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

const BASE = 'https://api.github.com';

// Branch names and file paths go into URLs — encode them so names containing
// '#', '?', '&', '%' or spaces don't truncate or corrupt the request.
const encRef = (ref: string) => encodeURIComponent(ref);
const encPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// Run conclusions that mean "CI is red". startup_failure is what GitHub reports
// when a workflow file is invalid and no job ever starts.
const FAILED_CONCLUSIONS = new Set(['failure', 'startup_failure', 'timed_out']);
export const isFailedConclusion = (c: string | null | undefined) => !!c && FAILED_CONCLUSIONS.has(c);

function h(pat: string): HeadersInit {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export async function getRepo(pat: string, owner: string, repo: string): Promise<RepoInfo> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}`, { headers: h(pat) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const d = await res.json();
  return {
    owner,
    repo,
    fullName: d.full_name,
    defaultBranch: d.default_branch,
    description: d.description || '',
    isPrivate: d.private,
    stars: d.stargazers_count ?? 0,
    forks: d.forks_count ?? 0,
    language: d.language ?? '',
    openIssues: d.open_issues_count ?? 0,
  };
}

export async function getLatestFailedRun(pat: string, owner: string, repo: string): Promise<WorkflowRun | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/runs?status=failure&per_page=5`, { headers: h(pat) });
  if (!res.ok) return null;
  const d = await res.json();
  return d.workflow_runs?.[0] ?? null;
}

/** Return the most-recent failed run for EACH distinct workflow name on a specific branch.
 *  Only includes workflows where the LATEST run is still failing — skips workflows
 *  that have since been fixed (i.e. their newest run is a success). */
export async function getAllLatestFailedRuns(pat: string, owner: string, repo: string, branch: string): Promise<WorkflowRun[]> {
  // Fetch all recent runs on this branch (not pre-filtered by status) so we can
  // check whether each workflow's *latest* run is actually still failing.
  const url = `${BASE}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`;
  const res = await fetch(url, { headers: h(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  const runs: WorkflowRun[] = d.workflow_runs ?? [];

  // For each workflow, keep only the most recent run (runs are newest-first from the API).
  // Keyed by workflow_id (file identity) so two workflows sharing a display name
  // don't hide each other.
  const latestPerWorkflow = new Map<number | string, WorkflowRun>();
  for (const r of runs) {
    const key = r.workflow_id ?? r.name;
    if (!latestPerWorkflow.has(key)) latestPerWorkflow.set(key, r);
  }

  // Only return workflows whose most recent run is a failure.
  return [...latestPerWorkflow.values()].filter(r => FAILED_CONCLUSIONS.has(r.conclusion));
}

/** Return failed workflow runs on a specific branch (used for deep-diagnosis after FIX_UNVERIFIED). */
export async function getFailedRunsForBranch(pat: string, owner: string, repo: string, branch: string): Promise<WorkflowRun[]> {
  const url = `${BASE}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&status=failure&per_page=10`;
  const res = await fetch(url, { headers: h(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  const runs: WorkflowRun[] = d.workflow_runs ?? [];
  const seen = new Map<string, WorkflowRun>();
  for (const r of runs) {
    if (!seen.has(r.name)) seen.set(r.name, r);
  }
  return [...seen.values()];
}

export async function getRunJobs(pat: string, owner: string, repo: string, runId: number): Promise<WorkflowJob[]> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { headers: h(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.jobs ?? []).map((job: Record<string, unknown>) => ({
    id: job.id as number,
    name: job.name as string,
    conclusion: (job.conclusion ?? '') as string,
    startedAt: job.started_at as string | undefined,
    completedAt: job.completed_at as string | undefined,
    steps: ((job.steps as Record<string, unknown>[]) ?? []).map(s => ({
      name: s.name as string,
      conclusion: s.conclusion as string | null,
      number: s.number as number,
      startedAt: s.started_at as string | undefined,
      completedAt: s.completed_at as string | undefined,
    })),
  }));
}

export async function getWorkflowFiles(pat: string, owner: string, repo: string, branch: string): Promise<FileContent[]> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/contents/.github/workflows?ref=${encRef(branch)}`, { headers: h(pat) });
  if (!res.ok) return [];
  const files = await res.json();
  if (!Array.isArray(files)) return [];

  const yamls = files.filter((f: { name: string }) => f.name.endsWith('.yml') || f.name.endsWith('.yaml'));
  const results = await Promise.all(
    yamls.map(async (f: { path: string }) => {
      const r = await fetch(`${BASE}/repos/${owner}/${repo}/contents/${encPath(f.path)}?ref=${encRef(branch)}`, { headers: h(pat) });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d || d.encoding !== 'base64' || !d.content || !d.path) return null;
      return { path: d.path, content: b64DecodeUtf8(d.content), sha: d.sha ?? '' } as FileContent;
    })
  );
  return results.filter(Boolean) as FileContent[];
}

export async function getJobLogs(pat: string, owner: string, repo: string, jobId: number): Promise<string> {
  try {
    const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
      headers: h(pat),
      redirect: 'follow',
    });
    if (!res.ok) return '';
    const text = await res.text();
    const lines = text.split('\n').map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '').trim()).filter(Boolean);
    return lines.slice(-300).join('\n');
  } catch {
    return '';
  }
}

// Fetch a single file from any path in the repo (e.g. package.json, Dockerfile, .nvmrc)
export async function fetchRepoFile(
  pat: string, owner: string, repo: string, path: string, branch: string,
): Promise<FileContent | null> {
  try {
    const res = await fetch(`${BASE}/repos/${owner}/${repo}/contents/${encPath(path)}?ref=${encRef(branch)}`, { headers: h(pat) });
    if (!res.ok) return null;
    const d = await res.json();
    if (d.encoding !== 'base64' || !d.content) return null;
    return { path: d.path, content: b64DecodeUtf8(d.content), sha: d.sha };
  } catch {
    return null;
  }
}

export async function createBranch(pat: string, owner: string, repo: string, branch: string, from: string): Promise<boolean> {
  const refRes = await fetch(`${BASE}/repos/${owner}/${repo}/git/ref/heads/${encPath(from)}`, { headers: h(pat) });
  if (!refRes.ok) {
    const body = await refRes.json().catch(() => ({}));
    console.error(`[AEGIS] createBranch: get-ref failed HTTP ${refRes.status}`, body);
    return false;
  }
  const refData = await refRes.json();
  const sha = refData.object?.sha;
  if (!sha) { console.error('[AEGIS] createBranch: no SHA in ref response', refData); return false; }

  const res = await fetch(`${BASE}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`[AEGIS] createBranch: create-ref failed HTTP ${res.status}`, body);
  }
  return res.ok;
}

export async function commitFile(
  pat: string, owner: string, repo: string,
  path: string, content: string, sha: string, message: string, branch: string
): Promise<string | null> {
  const put = (fileSha: string) => fetch(`${BASE}/repos/${owner}/${repo}/contents/${encPath(path)}`, {
    method: 'PUT',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64EncodeUtf8(content), ...(fileSha ? { sha: fileSha } : {}), branch }),
  });
  let res = await put(sha);
  // 409 = stale sha, 422 = file exists but no sha given (AI "created" a file
  // that was never fetched). Look up the real blob sha on the branch and retry once.
  if (res.status === 409 || res.status === 422) {
    const current = await fetchRepoFile(pat, owner, repo, path, branch);
    if (current?.sha && current.sha !== sha) res = await put(current.sha);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[AEGIS] commitFile failed HTTP ${res.status} path=${path}`, err);
    return null;
  }
  const d = await res.json();
  return d.commit?.sha ?? null;
}

export async function createPR(
  pat: string, owner: string, repo: string,
  title: string, body: string, head: string, base: string
): Promise<string | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[AEGIS] createPR failed HTTP ${res.status}`, err);
    return null;
  }
  const d = await res.json();
  return d.html_url ?? null;
}

export interface WorkflowCheckStatus {
  name: string;
  runId: number;
  conclusion: string | null;
  status: string;
  url: string;
  createdAt: string;
  failedJobs: Array<{
    name: string;
    failedSteps: string[];
  }>;
}

// Fetch the most recent run per workflow ON THE DEFAULT BRANCH and collect failed job details.
// Returns failures first, then passing checks alphabetically.
// Branch-scoped so Aegis fix branches (aegis/fix-*) don't pollute the health status.
export async function getComprehensiveCI(
  pat: string, owner: string, repo: string, branch = 'main'
): Promise<WorkflowCheckStatus[]> {
  const url = `${BASE}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=30`;
  const res = await fetch(url, { headers: h(pat) });
  if (!res.ok) return [];
  const data = await res.json();

  // Deduplicate by workflow_id (file identity) not display name — so a renamed
  // workflow doesn't leave stale failing runs from before the rename in the list.
  const latestByWorkflow = new Map<number, Record<string, unknown>>();
  for (const run of (data.workflow_runs ?? []) as Record<string, unknown>[]) {
    const wfId = run.workflow_id as number;
    const existing = latestByWorkflow.get(wfId);
    if (!existing || new Date(run.created_at as string) > new Date(existing.created_at as string)) {
      latestByWorkflow.set(wfId, run);
    }
  }

  const results = await Promise.all(
    [...latestByWorkflow.values()].map(async (run) => {
      let failedJobs: Array<{ name: string; failedSteps: string[] }> = [];
      if (FAILED_CONCLUSIONS.has(run.conclusion as string)) {
        const jobs = await getRunJobs(pat, owner, repo, run.id as number);
        failedJobs = jobs
          .filter(j => j.conclusion === 'failure')
          .map(j => ({
            name: j.name,
            failedSteps: j.steps.filter(s => s.conclusion === 'failure').map(s => s.name),
          }));
      }
      return {
        name: run.name as string,
        runId: run.id as number,
        conclusion: run.conclusion as string | null,
        status: run.status as string,
        url: run.html_url as string,
        createdAt: run.created_at as string,
        failedJobs,
      } as WorkflowCheckStatus;
    })
  );

  // Failures first, then alphabetical
  return results.sort((a, b) => {
    const aFailed = isFailedConclusion(a.conclusion), bFailed = isFailedConclusion(b.conclusion);
    if (aFailed !== bFailed) return aFailed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Poll CI runs on a specific branch until all complete or timeout.
// Used to verify that an aegis fix branch actually passes CI.
export async function waitForBranchCI(
  pat: string, owner: string, repo: string, branch: string,
  maxWaitMs = 60_000,
  pollIntervalMs = 15_000,
): Promise<'success' | 'failure' | 'timeout'> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, pollIntervalMs));
    if (Date.now() >= deadline) break;

    const res = await fetch(
      `${BASE}/repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=10`,
      { headers: h(pat) },
    ).catch(() => null);

    if (!res?.ok) continue;
    const d = await res.json().catch(() => null);
    if (!d) continue;

    const runs: WorkflowRun[] = d.workflow_runs ?? [];
    if (runs.length === 0) continue;  // CI not triggered yet — keep waiting

    const anyInProgress = runs.some(r =>
      r.status === 'in_progress' || r.status === 'queued' || r.status === 'pending' ||
      r.status === 'waiting' || r.status === 'requested',
    );
    if (anyInProgress) continue;  // Still running — keep polling

    // A cancelled or timed-out run is not a green build — don't report the fix as verified.
    return runs.some(r => FAILED_CONCLUSIONS.has(r.conclusion) || r.conclusion === 'cancelled') ? 'failure' : 'success';
  }

  return 'timeout';
}

/** Find the most recent open PR created by Aegis (branch name starts with aegis/fix-). */
export async function getOpenAegisPR(
  pat: string, owner: string, repo: string,
): Promise<{ number: number; branch: string; html_url: string } | null> {
  const res = await fetch(
    `${BASE}/repos/${owner}/${repo}/pulls?state=open&per_page=20`,
    { headers: h(pat) },
  ).catch(() => null);
  if (!res?.ok) return null;
  const prs = await res.json().catch(() => null);
  if (!Array.isArray(prs)) return null;
  const aegisPR = prs.find((pr: { head?: { ref?: string }; number?: number; html_url?: string }) =>
    pr.head?.ref?.startsWith('aegis/fix-')
  );
  if (!aegisPR) return null;
  return { number: aegisPR.number, branch: aegisPR.head.ref, html_url: aegisPR.html_url };
}

// ═══════════════════════════════════════════════════════════════════════════
// Fallback-strategy API (flaky rerun, autofix job, revert-to-last-green)
// ═══════════════════════════════════════════════════════════════════════════

/** Full job log (timestamps stripped) — getJobLogs keeps only the tail. */
export async function getJobLogsFull(pat: string, owner: string, repo: string, jobId: number): Promise<string> {
  try {
    const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, { headers: h(pat), redirect: 'follow' });
    if (!res.ok) return '';
    return (await res.text()).split('\n').map(l => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '')).join('\n');
  } catch {
    return '';
  }
}

/** Re-run only the failed jobs of a workflow run (new attempt on the same run id). */
export async function rerunFailedJobs(pat: string, owner: string, repo: string, runId: number): Promise<boolean> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {
    method: 'POST', headers: h(pat),
  }).catch(() => null);
  return !!res?.ok;
}

export async function getRun(pat: string, owner: string, repo: string, runId: number): Promise<WorkflowRun | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/runs/${runId}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

/** Poll one run until it completes. Returns its conclusion bucket. */
export async function waitForRun(
  pat: string, owner: string, repo: string, runId: number,
  maxWaitMs = 8 * 60_000, pollMs = 15_000, isCancelled: () => boolean = () => false,
): Promise<'success' | 'failure' | 'timeout'> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && !isCancelled()) {
    await new Promise(r => setTimeout(r, pollMs));
    const run = await getRun(pat, owner, repo, runId);
    if (!run || run.status !== 'completed') continue;
    return run.conclusion === 'success' ? 'success' : 'failure';
  }
  return 'timeout';
}

/** Newest successful run of a workflow on a branch — the "last green" commit. */
export async function getLastGreenRun(
  pat: string, owner: string, repo: string, branch: string, workflowId?: number,
): Promise<WorkflowRun | null> {
  const path = workflowId ? `actions/workflows/${workflowId}/runs` : 'actions/runs';
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/${path}?branch=${encRef(branch)}&status=success&per_page=1`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  return d?.workflow_runs?.[0] ?? null;
}

export interface CommitSummary { sha: string; message: string; parent: string | null }
export interface ChangedFile { path: string; status: 'added' | 'removed' | 'modified' | 'renamed'; previousPath?: string }

/** Commits and changed files between a good and a bad commit (base...head). */
export async function compareCommits(
  pat: string, owner: string, repo: string, base: string, head: string,
): Promise<{ commits: CommitSummary[]; files: ChangedFile[] } | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/compare/${base}...${head}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d) return null;
  return {
    commits: (d.commits ?? []).map((c: { sha: string; commit: { message: string }; parents?: Array<{ sha: string }> }) => ({
      sha: c.sha, message: c.commit.message.split('\n')[0], parent: c.parents?.[0]?.sha ?? null,
    })),
    files: (d.files ?? []).map((f: { filename: string; status: string; previous_filename?: string }) => ({
      path: f.filename,
      status: (['added', 'removed', 'renamed'].includes(f.status) ? f.status : 'modified') as ChangedFile['status'],
      previousPath: f.previous_filename,
    })),
  };
}

/** Files changed by a single commit. */
export async function getCommitFiles(pat: string, owner: string, repo: string, sha: string): Promise<ChangedFile[]> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/commits/${sha}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return [];
  const d = await res.json().catch(() => null);
  return (d?.files ?? []).map((f: { filename: string; status: string; previous_filename?: string }) => ({
    path: f.filename,
    status: (['added', 'removed', 'renamed'].includes(f.status) ? f.status : 'modified') as ChangedFile['status'],
    previousPath: f.previous_filename,
  }));
}

export async function getBranchSha(pat: string, owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/git/ref/heads/${encPath(branch)}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null))?.object?.sha ?? null;
}

export async function deleteFile(
  pat: string, owner: string, repo: string, path: string, message: string, branch: string,
): Promise<boolean> {
  const current = await fetchRepoFile(pat, owner, repo, path, branch);
  if (!current?.sha) return false;
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/contents/${encPath(path)}`, {
    method: 'DELETE',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha: current.sha, branch }),
  }).catch(() => null);
  return !!res?.ok;
}

export async function deleteBranch(pat: string, owner: string, repo: string, branch: string): Promise<boolean> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/git/refs/heads/${encPath(branch)}`, {
    method: 'DELETE', headers: h(pat),
  }).catch(() => null);
  return !!res?.ok;
}

/** Newest workflow run on a branch whose workflow name matches (e.g. the Aegis autofix job). */
export async function findRunOnBranch(
  pat: string, owner: string, repo: string, branch: string, workflowName?: string,
): Promise<WorkflowRun | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/actions/runs?branch=${encRef(branch)}&per_page=10`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const runs: WorkflowRun[] = (await res.json().catch(() => null))?.workflow_runs ?? [];
  return runs.find(r => !workflowName || r.name === workflowName) ?? null;
}

// ── Git Data API — build a single commit from file-level restores ────────────

export interface TreeEntry { path: string; mode: string; sha: string; type: string }

/** Every blob in a commit's tree (path → mode + blob sha). */
export async function getTreeEntries(pat: string, owner: string, repo: string, commitSha: string): Promise<Map<string, TreeEntry> | null> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d?.tree || d.truncated) return null; // truncated trees are unsafe to restore from
  return new Map((d.tree as TreeEntry[]).filter(e => e.type === 'blob').map(e => [e.path, e]));
}

/**
 * Create one commit on top of `parentSha` where each listed path is set to the
 * given blob (restore) or removed (`null`), then point a NEW branch at it.
 */
export async function createBranchWithCommit(
  pat: string, owner: string, repo: string, branch: string, parentSha: string,
  changes: Array<{ path: string; entry: TreeEntry | null }>, message: string,
): Promise<string | null> {
  const json = { ...h(pat), 'Content-Type': 'application/json' };
  const parent = await fetch(`${BASE}/repos/${owner}/${repo}/git/commits/${parentSha}`, { headers: h(pat) }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!parent?.tree?.sha) return null;
  const tree = await fetch(`${BASE}/repos/${owner}/${repo}/git/trees`, {
    method: 'POST', headers: json,
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: changes.map(c => (c.entry
        ? { path: c.path, mode: c.entry.mode, type: 'blob', sha: c.entry.sha }
        : { path: c.path, mode: '100644', type: 'blob', sha: null })),
    }),
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!tree?.sha) return null;
  const commit = await fetch(`${BASE}/repos/${owner}/${repo}/git/commits`, {
    method: 'POST', headers: json, body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!commit?.sha) return null;
  const ref = await fetch(`${BASE}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST', headers: json, body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  }).catch(() => null);
  return ref?.ok ? commit.sha : null;
}
