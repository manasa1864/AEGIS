import { Issue } from '../types';
import { mcpListIssues, mcpCreateIssue, mcpUpdateIssueState } from './gitlabMcp';

const GH = 'https://api.github.com';
const GL = 'https://gitlab.com/api/v4';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function glH(pat: string): HeadersInit {
  return { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' };
}
function pid(o: string, r: string) { return encodeURIComponent(`${o}/${r}`); }

// ── GitHub Issues ─────────────────────────────────────────────────────────────

export async function getGithubIssues(pat: string, owner: string, repo: string, state: 'open' | 'closed' = 'open'): Promise<Issue[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/issues?state=${state}&per_page=30`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : [])
    .filter((i: Record<string, unknown>) => !i.pull_request)
    .map((i: Record<string, unknown>) => ({
      id: i.id as number,
      number: i.number as number,
      title: i.title as string,
      state: i.state as 'open' | 'closed',
      url: i.html_url as string,
      createdAt: i.created_at as string,
      labels: ((i.labels as Record<string, string>[]) ?? []).map(l => l.name),
      author: (i.user as Record<string, string>)?.login ?? '',
    }));
}

export async function createGithubIssue(pat: string, owner: string, repo: string, title: string, body: string): Promise<Issue | null> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) return null;
  const i = await res.json();
  return { id: i.id, number: i.number, title: i.title, state: 'open', url: i.html_url, createdAt: i.created_at, labels: [], author: i.user?.login ?? '' };
}

export async function updateGithubIssueState(pat: string, owner: string, repo: string, issueNumber: number, state: 'open' | 'closed'): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  return res.ok;
}

// ── GitLab Issues ─────────────────────────────────────────────────────────────

export async function getGitlabIssues(pat: string, owner: string, repo: string, state: 'opened' | 'closed' = 'opened'): Promise<Issue[]> {
  // Try MCP bridge first; fall back to direct GitLab REST API
  const mcp = await mcpListIssues(pat, owner, repo, state);
  if (mcp) return mcp;

  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/issues?state=${state}&per_page=30`, { headers: glH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((i: Record<string, unknown>) => ({
    id: i.id as number,
    number: i.iid as number,
    title: i.title as string,
    state: (i.state as string) === 'opened' ? 'open' : 'closed',
    url: i.web_url as string,
    createdAt: i.created_at as string,
    labels: (i.labels as string[]) ?? [],
    author: (i.author as Record<string, string>)?.name ?? '',
  }));
}

export async function createGitlabIssue(pat: string, owner: string, repo: string, title: string, body: string): Promise<Issue | null> {
  const mcp = await mcpCreateIssue(pat, owner, repo, title, body);
  if (mcp) return mcp;

  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/issues`, {
    method: 'POST', headers: glH(pat),
    body: JSON.stringify({ title, description: body }),
  });
  if (!res.ok) return null;
  const i = await res.json();
  return { id: i.id, number: i.iid, title: i.title, state: 'open', url: i.web_url, createdAt: i.created_at, labels: i.labels ?? [], author: i.author?.name ?? '' };
}

export async function updateGitlabIssueState(pat: string, owner: string, repo: string, issueIid: number, event: 'reopen' | 'close'): Promise<boolean> {
  const ok = await mcpUpdateIssueState(pat, owner, repo, issueIid, event);
  if (ok) return true;

  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/issues/${issueIid}`, {
    method: 'PUT', headers: glH(pat),
    body: JSON.stringify({ state_event: event }),
  });
  return res.ok;
}
