/**
 * GitLab MCP client — calls the Aegis MCP bridge server (server.js).
 * In dev the Vite proxy routes /api/mcp → localhost:3001.
 * Each function returns null if the MCP bridge is unreachable so callers
 * can fall back to the direct GitLab REST API.
 */

import { Issue, CIPipeline } from '../types';

const BASE = '/api/mcp/gitlab';

async function mcpFetch(url: string, opts?: RequestInit, token?: string): Promise<unknown> {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-gitlab-token': token } : {}),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`MCP bridge ${res.status}`);
  return res.json();
}

// Parse the MCP tool response text content into a typed value
function parseMcpContent<T>(raw: unknown): T | null {
  try {
    const content = (raw as { content?: { text?: string }[] })?.content;
    if (!Array.isArray(content) || !content[0]?.text) return null;
    return JSON.parse(content[0].text) as T;
  } catch {
    return null;
  }
}

// ── Issues ────────────────────────────────────────────────────────────────────

export async function mcpListIssues(
  pat: string, owner: string, repo: string, state: 'opened' | 'closed',
): Promise<Issue[] | null> {
  try {
    const raw = await mcpFetch(
      `${BASE}/issues?project_id=${encodeURIComponent(`${owner}/${repo}`)}&state=${state}`,
      {}, pat,
    );
    const data = parseMcpContent<Record<string, unknown>[]>(raw);
    if (!Array.isArray(data)) return null;
    return data.map(i => ({
      id: i.id as number,
      number: (i.iid ?? i.number) as number,
      title: i.title as string,
      state: (i.state as string) === 'opened' ? 'open' : 'closed',
      url: (i.web_url ?? i.url) as string,
      createdAt: i.created_at as string,
      labels: (i.labels as string[]) ?? [],
      author: ((i.author as Record<string, string>)?.name ?? (i.author as Record<string, string>)?.username ?? '') as string,
    }));
  } catch {
    return null;
  }
}

export async function mcpCreateIssue(
  pat: string, owner: string, repo: string, title: string, description: string,
): Promise<Issue | null> {
  try {
    const raw = await mcpFetch(`${BASE}/issues`, {
      method: 'POST',
      body: JSON.stringify({ project_id: `${owner}/${repo}`, title, description }),
    }, pat);
    const i = parseMcpContent<Record<string, unknown>>(raw);
    if (!i) return null;
    return {
      id: i.id as number,
      number: (i.iid ?? i.number) as number,
      title: i.title as string,
      state: 'open',
      url: (i.web_url ?? i.url) as string,
      createdAt: i.created_at as string,
      labels: [],
      author: ((i.author as Record<string, string>)?.name ?? '') as string,
    };
  } catch {
    return null;
  }
}

export async function mcpUpdateIssueState(
  pat: string, owner: string, repo: string, iid: number, event: 'close' | 'reopen',
): Promise<boolean> {
  try {
    await mcpFetch(`${BASE}/issues/${iid}`, {
      method: 'PATCH',
      body: JSON.stringify({ project_id: `${owner}/${repo}`, state_event: event }),
    }, pat);
    return true;
  } catch {
    return false;
  }
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

export async function mcpListPipelines(
  pat: string, owner: string, repo: string,
): Promise<CIPipeline[] | null> {
  try {
    const raw = await mcpFetch(
      `${BASE}/pipelines?project_id=${encodeURIComponent(`${owner}/${repo}`)}`,
      {}, pat,
    );
    const data = parseMcpContent<Record<string, unknown>[]>(raw);
    if (!Array.isArray(data)) return null;
    return data.map(p => ({
      id: p.id as number,
      status: p.status as string,
      ref: p.ref as string,
      url: (p.web_url ?? p.url) as string,
      createdAt: p.created_at as string,
    }));
  } catch {
    return null;
  }
}

// ── Merge Requests ────────────────────────────────────────────────────────────

export async function mcpCreateMR(
  pat: string, owner: string, repo: string,
  title: string, description: string, sourceBranch: string, targetBranch: string,
): Promise<string | null> {
  try {
    const raw = await mcpFetch(`${BASE}/mrs`, {
      method: 'POST',
      body: JSON.stringify({
        project_id: `${owner}/${repo}`,
        title, description,
        source_branch: sourceBranch,
        target_branch: targetBranch,
      }),
    }, pat);
    const mr = parseMcpContent<Record<string, unknown>>(raw);
    return (mr?.web_url ?? mr?.url) as string | null;
  } catch {
    return null;
  }
}
