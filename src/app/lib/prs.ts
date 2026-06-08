import { PullRequest } from '../types';

const GH = 'https://api.github.com';
const GL = 'https://gitlab.com/api/v4';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function glH(pat: string): HeadersInit {
  return { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' };
}
function pid(o: string, r: string) { return encodeURIComponent(`${o}/${r}`); }

// ── GitHub Pull Requests ──────────────────────────────────────────────────────

export async function getGithubPRs(pat: string, owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<PullRequest[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls?state=${state}&per_page=30`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((p: Record<string, unknown>) => ({
    id: p.id as number,
    number: p.number as number,
    title: p.title as string,
    state: (p.merged_at ? 'merged' : p.state) as 'open' | 'closed' | 'merged',
    url: p.html_url as string,
    sourceBranch: (p.head as Record<string, string>)?.ref ?? '',
    targetBranch: (p.base as Record<string, string>)?.ref ?? '',
    createdAt: p.created_at as string,
    author: (p.user as Record<string, string>)?.login ?? '',
    draft: (p.draft as boolean) ?? false,
  }));
}

export async function createGithubPR(pat: string, owner: string, repo: string, title: string, body: string, head: string, base: string): Promise<PullRequest | null> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!res.ok) return null;
  const p = await res.json();
  return { id: p.id, number: p.number, title: p.title, state: 'open', url: p.html_url, sourceBranch: head, targetBranch: base, createdAt: p.created_at, author: p.user?.login ?? '', draft: false };
}

export async function mergeGithubPR(pat: string, owner: string, repo: string, prNumber: number): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  return res.ok;
}

export async function closeGithubPR(pat: string, owner: string, repo: string, prNumber: number): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  return res.ok;
}

// ── GitLab Merge Requests ─────────────────────────────────────────────────────

export async function getGitlabMRs(pat: string, owner: string, repo: string, state: 'opened' | 'merged' | 'closed' = 'opened'): Promise<PullRequest[]> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/merge_requests?state=${state}&per_page=30`, { headers: glH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((m: Record<string, unknown>) => ({
    id: m.id as number,
    number: m.iid as number,
    title: m.title as string,
    state: (m.state === 'merged' ? 'merged' : m.state === 'closed' ? 'closed' : 'open') as 'open' | 'closed' | 'merged',
    url: m.web_url as string,
    sourceBranch: m.source_branch as string,
    targetBranch: m.target_branch as string,
    createdAt: m.created_at as string,
    author: (m.author as Record<string, string>)?.name ?? '',
    draft: (m.draft as boolean) ?? false,
  }));
}

export async function createGitlabMR(pat: string, owner: string, repo: string, title: string, body: string, sourceBranch: string, targetBranch: string): Promise<PullRequest | null> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/merge_requests`, {
    method: 'POST', headers: glH(pat),
    body: JSON.stringify({ title, description: body, source_branch: sourceBranch, target_branch: targetBranch }),
  });
  if (!res.ok) return null;
  const m = await res.json();
  return { id: m.id, number: m.iid, title: m.title, state: 'open', url: m.web_url, sourceBranch, targetBranch, createdAt: m.created_at, author: m.author?.name ?? '', draft: false };
}

export async function mergeGitlabMR(pat: string, owner: string, repo: string, mrIid: number): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/merge_requests/${mrIid}/merge`, { method: 'PUT', headers: glH(pat) });
  return res.ok;
}

export async function closeGitlabMR(pat: string, owner: string, repo: string, mrIid: number): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/merge_requests/${mrIid}`, {
    method: 'PUT', headers: glH(pat),
    body: JSON.stringify({ state_event: 'close' }),
  });
  return res.ok;
}

// Returns unified diff text for a GitHub PR (Accept: diff header)
export async function getGithubPRDiff(pat: string, owner: string, repo: string, prNumber: number): Promise<string> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github.v3.diff', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) return '';
  return res.text();
}
