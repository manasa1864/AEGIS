import { b64DecodeUtf8 } from './base64';

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

export interface PipelineRun {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
}

export interface PipelineJob {
  id: number;
  name: string;
  status: string;
  stage: string;
  failure_reason?: string;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
}

// Self-hosted GitLab: the dashboard calls setGitlabHost() from Settings.
// The instance must allow CORS from this app's origin (browser → API directly).
let BASE = 'https://gitlab.com/api/v4';
let HOST = 'gitlab.com';

/** Point every GitLab call at a self-hosted instance ("gitlab.example.com" or a full URL). */
export function setGitlabHost(hostOrUrl: string | null | undefined): void {
  const raw = (hostOrUrl ?? '').trim().replace(/\/+$/, '');
  if (!raw) { BASE = 'https://gitlab.com/api/v4'; HOST = 'gitlab.com'; return; }
  const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  HOST = url.replace(/^https?:\/\//, '').split('/')[0];
  BASE = `${url.replace(/\/api\/v4$/, '')}/api/v4`;
}

/** Hostname of the GitLab instance in use (for recognising repo URLs). */
export const gitlabHost = () => HOST;

function h(pat: string): HeadersInit {
  return {
    'PRIVATE-TOKEN': pat,
    'Content-Type': 'application/json',
  };
}

function pid(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

export async function getRepo(pat: string, owner: string, repo: string): Promise<RepoInfo> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}`, { headers: h(pat) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const d = await res.json();
  return {
    owner,
    repo,
    fullName: d.path_with_namespace,
    defaultBranch: d.default_branch,
    description: d.description || '',
    isPrivate: d.visibility !== 'public',
    stars: d.star_count ?? 0,
    forks: d.forks_count ?? 0,
    language: d.predominant_language ?? '',
    openIssues: d.open_issues_count ?? 0,
  };
}

export async function getLatestFailedPipeline(pat: string, owner: string, repo: string): Promise<PipelineRun | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines?status=failed&per_page=5`, { headers: h(pat) });
  if (!res.ok) return null;
  const d = await res.json();
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}

export async function getFailedPipelineOnBranch(
  pat: string, owner: string, repo: string, branch: string,
): Promise<PipelineRun | null> {
  const ref = encodeURIComponent(branch);
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines?ref=${ref}&status=failed&per_page=5`, { headers: h(pat) });
  if (!res.ok) return null;
  const d = await res.json();
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}

export async function getPipelineJobs(pat: string, owner: string, repo: string, pipelineId: number): Promise<PipelineJob[]> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines/${pipelineId}/jobs`, { headers: h(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return Array.isArray(d) ? d : [];
}

export async function getWorkflowFiles(pat: string, owner: string, repo: string, branch: string): Promise<FileContent[]> {
  const filePath = encodeURIComponent('.gitlab-ci.yml');
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/files/${filePath}?ref=${encodeURIComponent(branch)}`, { headers: h(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  try {
    return [{
      path: '.gitlab-ci.yml',
      content: b64DecodeUtf8(d.content),
      sha: d.blob_id,
    }];
  } catch {
    return [];
  }
}

// Fetch a single file at any path (e.g. package.json, Dockerfile, requirements.txt)
export async function fetchRepoFile(
  pat: string, owner: string, repo: string, path: string, branch: string,
): Promise<FileContent | null> {
  try {
    const filePath = encodeURIComponent(path);
    const res = await fetch(
      `${BASE}/projects/${pid(owner, repo)}/repository/files/${filePath}?ref=${encodeURIComponent(branch)}`,
      { headers: h(pat) },
    );
    if (!res.ok) return null;
    const d = await res.json();
    return { path, content: b64DecodeUtf8(d.content), sha: d.blob_id };
  } catch {
    return null;
  }
}

// Fetch the tail of a job's trace log. 300 lines matches the GitHub side —
// GitLab errors often sit above after_script/cleanup output, which 60 lines
// regularly cut off. chunkLogs() trims this further before it reaches the AI.
export async function getJobLogs(
  pat: string, owner: string, repo: string, jobId: number,
): Promise<string> {
  try {
    const res = await fetch(
      `${BASE}/projects/${pid(owner, repo)}/jobs/${jobId}/trace`,
      { headers: h(pat) },
    );
    if (!res.ok) return '';
    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.slice(-300).join('\n');
  } catch {
    return '';
  }
}

export async function createBranch(pat: string, owner: string, repo: string, branch: string, from: string): Promise<boolean> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/branches`, {
    method: 'POST',
    headers: h(pat),
    body: JSON.stringify({ branch, ref: from }),
  });
  return res.ok;
}

export async function commitFile(
  pat: string, owner: string, repo: string,
  path: string, content: string, message: string, branch: string,
): Promise<string | null> {
  const filePath = encodeURIComponent(path);
  const body = JSON.stringify({ branch, content, commit_message: message, encoding: 'text' });
  // Try update first; if the file doesn't exist yet, create it
  let res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/files/${filePath}`, {
    method: 'PUT', headers: h(pat), body,
  });
  if (!res.ok) {
    res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/files/${filePath}`, {
      method: 'POST', headers: h(pat), body,
    });
  }
  if (!res.ok) return null;
  const d = await res.json();
  return d.file_path ?? null;
}

export async function createMR(
  pat: string, owner: string, repo: string,
  title: string, description: string, sourceBranch: string, targetBranch: string
): Promise<string | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/merge_requests`, {
    method: 'POST',
    headers: h(pat),
    body: JSON.stringify({ title, description, source_branch: sourceBranch, target_branch: targetBranch }),
  });
  if (!res.ok) return null;
  const d = await res.json();
  return d.web_url ?? null;
}

// Poll pipelines on a specific branch until complete or timeout.
// Used to verify that an aegis fix branch actually passes CI.
export async function waitForBranchPipeline(
  pat: string, owner: string, repo: string, branch: string,
  maxWaitMs = 60_000,
  pollIntervalMs = 15_000,
): Promise<'success' | 'failure' | 'timeout'> {
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, pollIntervalMs));
    if (Date.now() >= deadline) break;

    const res = await fetch(
      `${BASE}/projects/${pid(owner, repo)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=5`,
      { headers: h(pat) },
    ).catch(() => null);

    if (!res?.ok) continue;
    const pipelines = await res.json().catch(() => null);
    if (!Array.isArray(pipelines) || pipelines.length === 0) continue;

    const latest = pipelines[0] as { status: string };
    const status = latest.status;

    if (status === 'running' || status === 'pending' || status === 'created'
      || status === 'waiting_for_resource' || status === 'preparing' || status === 'scheduled') continue;
    if (status === 'success') return 'success';
    if (status === 'failed' || status === 'canceled') return 'failure';
    // 'skipped' or unknown — treat as non-failure
    return 'success';
  }

  return 'timeout';
}

// ═══════════════════════════════════════════════════════════════════════════
// Fallback-strategy API (flaky retry, autofix job, revert-to-last-green)
// ═══════════════════════════════════════════════════════════════════════════

export async function getJobLogsFull(pat: string, owner: string, repo: string, jobId: number): Promise<string> {
  try {
    const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/jobs/${jobId}/trace`, { headers: h(pat) });
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

/** Retry the failed jobs of a pipeline (GitLab reuses the same pipeline id). */
export async function retryPipeline(pat: string, owner: string, repo: string, pipelineId: number): Promise<boolean> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines/${pipelineId}/retry`, { method: 'POST', headers: h(pat) }).catch(() => null);
  return !!res?.ok;
}

export async function waitForPipeline(
  pat: string, owner: string, repo: string, pipelineId: number,
  maxWaitMs = 8 * 60_000, pollMs = 15_000, isCancelled: () => boolean = () => false,
): Promise<'success' | 'failure' | 'timeout'> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && !isCancelled()) {
    await new Promise(r => setTimeout(r, pollMs));
    const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines/${pipelineId}`, { headers: h(pat) }).catch(() => null);
    const p = res?.ok ? await res.json().catch(() => null) : null;
    if (!p) continue;
    if (p.status === 'success') return 'success';
    if (['failed', 'canceled'].includes(p.status)) return 'failure';
  }
  return 'timeout';
}

export async function getLastGreenPipeline(pat: string, owner: string, repo: string, ref: string): Promise<PipelineRun | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines?ref=${encodeURIComponent(ref)}&status=success&per_page=1`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}

export async function getNewestPipelineOnRef(pat: string, owner: string, repo: string, ref: string): Promise<PipelineRun | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines?ref=${encodeURIComponent(ref)}&per_page=1`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}

export interface CommitSummary { sha: string; message: string; parent: string | null }

/** Commits between a good and a bad sha (newest first). */
export async function compareCommits(
  pat: string, owner: string, repo: string, from: string, to: string,
): Promise<{ commits: CommitSummary[] } | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/compare?from=${from}&to=${to}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  if (!d) return null;
  return {
    commits: [...(d.commits ?? [])].reverse().map((c: { id: string; title: string; parent_ids?: string[] }) => ({
      sha: c.id, message: c.title, parent: c.parent_ids?.[0] ?? null,
    })),
  };
}

/** GitLab's native revert — a real 3-way revert commit of `sha` on `branch`. */
export async function revertCommit(pat: string, owner: string, repo: string, sha: string, branch: string): Promise<boolean> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/commits/${sha}/revert`, {
    method: 'POST', headers: h(pat), body: JSON.stringify({ branch }),
  }).catch(() => null);
  return !!res?.ok;
}

export async function deleteBranch(pat: string, owner: string, repo: string, branch: string): Promise<boolean> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/branches/${encodeURIComponent(branch)}`, { method: 'DELETE', headers: h(pat) }).catch(() => null);
  return !!res?.ok;
}

/** CI health for the dashboard panel — one row per job of the newest pipeline on `ref`. */
export async function getPipelineHealth(pat: string, owner: string, repo: string, ref: string): Promise<Array<{
  name: string; runId: number; conclusion: string | null; status: string; url: string; createdAt: string;
  failedJobs: Array<{ name: string; failedSteps: string[] }>;
}>> {
  const pipeline = await getNewestPipelineOnRef(pat, owner, repo, ref);
  if (!pipeline) return [];
  const jobs = await getPipelineJobs(pat, owner, repo, pipeline.id) as Array<PipelineJob & { web_url?: string; created_at?: string }>;
  const RUNNING = ['created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled', 'manual'];
  const rows = jobs.map(j => ({
    name: `${j.stage} · ${j.name}`,
    runId: j.id,
    status: RUNNING.includes(j.status) ? 'in_progress' : 'completed',
    conclusion: j.status === 'success' ? 'success' : j.status === 'failed' ? 'failure' : j.status === 'canceled' ? 'cancelled' : j.status === 'skipped' ? 'skipped' : null,
    url: j.web_url ?? pipeline.web_url,
    createdAt: j.created_at ?? pipeline.created_at,
    failedJobs: j.status === 'failed' ? [{ name: j.name, failedSteps: j.failure_reason ? [j.failure_reason] : [] }] : [],
  }));
  return rows.sort((a, b) => (a.conclusion === 'failure' ? 0 : 1) - (b.conclusion === 'failure' ? 0 : 1) || a.name.localeCompare(b.name));
}

export async function getBranchHead(pat: string, owner: string, repo: string, branch: string): Promise<string | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/repository/branches/${encodeURIComponent(branch)}`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null))?.commit?.id ?? null;
}

/** Newest pipeline for a specific commit on a ref (the one our commit triggered). */
export async function getPipelineForSha(pat: string, owner: string, repo: string, ref: string, sha: string): Promise<PipelineRun | null> {
  const res = await fetch(`${BASE}/projects/${pid(owner, repo)}/pipelines?ref=${encodeURIComponent(ref)}&sha=${sha}&per_page=1`, { headers: h(pat) }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json().catch(() => null);
  return Array.isArray(d) && d.length > 0 ? d[0] : null;
}
