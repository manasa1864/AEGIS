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

const BASE = 'https://gitlab.com/api/v4';

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
