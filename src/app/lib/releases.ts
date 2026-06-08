import { Release } from '../types';

const GH = 'https://api.github.com';
const GL = 'https://gitlab.com/api/v4';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function glH(pat: string): HeadersInit {
  return { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' };
}
function pid(o: string, r: string) { return encodeURIComponent(`${o}/${r}`); }

// ── GitHub Releases ───────────────────────────────────────────────────────────

export async function getGithubReleases(pat: string, owner: string, repo: string): Promise<Release[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/releases?per_page=20`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((r: Record<string, unknown>) => ({
    id: r.id as number,
    tag: r.tag_name as string,
    name: (r.name ?? r.tag_name) as string,
    body: (r.body ?? '') as string,
    draft: r.draft as boolean,
    prerelease: r.prerelease as boolean,
    url: r.html_url as string,
    createdAt: r.created_at as string,
  }));
}

export async function createGithubRelease(pat: string, owner: string, repo: string, tag: string, name: string, body: string, prerelease: boolean): Promise<Release | null> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease }),
  });
  if (!res.ok) return null;
  const r = await res.json();
  return { id: r.id, tag: r.tag_name, name: r.name, body: r.body ?? '', draft: r.draft, prerelease: r.prerelease, url: r.html_url, createdAt: r.created_at };
}

export async function deleteGithubRelease(pat: string, owner: string, repo: string, releaseId: number): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/releases/${releaseId}`, { method: 'DELETE', headers: ghH(pat) });
  return res.ok || res.status === 204;
}

// ── GitLab Releases ───────────────────────────────────────────────────────────

export async function getGitlabReleases(pat: string, owner: string, repo: string): Promise<Release[]> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/releases?per_page=20`, { headers: glH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((r: Record<string, unknown>, i: number) => ({
    id: i,
    tag: r.tag_name as string,
    name: (r.name ?? r.tag_name) as string,
    body: (r.description ?? '') as string,
    draft: false,
    prerelease: false,
    url: ((r._links as Record<string, string>)?.self) ?? '',
    createdAt: r.created_at as string,
  }));
}

export async function createGitlabRelease(pat: string, owner: string, repo: string, tag: string, name: string, body: string): Promise<Release | null> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/releases`, {
    method: 'POST', headers: glH(pat),
    body: JSON.stringify({ tag_name: tag, name, description: body }),
  });
  if (!res.ok) return null;
  const r = await res.json();
  return { id: 0, tag: r.tag_name, name: r.name, body: r.description ?? '', draft: false, prerelease: false, url: (r._links as Record<string, string>)?.self ?? '', createdAt: r.created_at };
}
