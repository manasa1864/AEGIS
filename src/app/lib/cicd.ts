import { CIRun, CIPipeline } from '../types';
import { mcpListPipelines } from './gitlabMcp';

const GH = 'https://api.github.com';
const GL = 'https://gitlab.com/api/v4';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function glH(pat: string): HeadersInit {
  return { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' };
}
function pid(o: string, r: string) { return encodeURIComponent(`${o}/${r}`); }

// ── GitHub Actions ────────────────────────────────────────────────────────────

export async function getGithubRuns(pat: string, owner: string, repo: string): Promise<CIRun[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/runs?per_page=25`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (d.workflow_runs ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    name: (r.name ?? r.display_title) as string,
    status: r.status as string,
    conclusion: (r.conclusion ?? null) as string | null,
    branch: r.head_branch as string,
    commitMsg: ((r.head_commit as Record<string, string>)?.message?.split('\n')[0]) ?? '',
    url: r.html_url as string,
    createdAt: r.created_at as string,
  }));
}

export async function rerunGithubRun(pat: string, owner: string, repo: string, runId: number): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, { method: 'POST', headers: ghH(pat) });
  return res.ok || res.status === 201;
}

export async function cancelGithubRun(pat: string, owner: string, repo: string, runId: number): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST', headers: ghH(pat) });
  return res.ok || res.status === 202;
}

// ── GitLab CI ─────────────────────────────────────────────────────────────────

export async function getGitlabPipelines(pat: string, owner: string, repo: string): Promise<CIPipeline[]> {
  // Try MCP bridge first; fall back to direct GitLab REST API
  const mcp = await mcpListPipelines(pat, owner, repo);
  if (mcp) return mcp;

  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/pipelines?per_page=25`, { headers: glH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((p: Record<string, unknown>) => ({
    id: p.id as number,
    status: p.status as string,
    ref: p.ref as string,
    url: p.web_url as string,
    createdAt: p.created_at as string,
  }));
}

export async function retryGitlabPipeline(pat: string, owner: string, repo: string, pipelineId: number): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/pipelines/${pipelineId}/retry`, { method: 'POST', headers: glH(pat) });
  return res.ok;
}

export async function cancelGitlabPipeline(pat: string, owner: string, repo: string, pipelineId: number): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/pipelines/${pipelineId}/cancel`, { method: 'POST', headers: glH(pat) });
  return res.ok;
}

export async function triggerGitlabPipeline(pat: string, owner: string, repo: string, ref: string): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/pipeline`, {
    method: 'POST', headers: glH(pat), body: JSON.stringify({ ref }),
  });
  return res.ok;
}
