const BASE = 'https://api.github.com';

function h(pat: string): HeadersInit {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function getAuthUser(pat: string): Promise<string | null> {
  const res = await fetch(`${BASE}/user`, { headers: h(pat) });
  if (!res.ok) return null;
  const d = await res.json();
  return d.login ?? null;
}

export async function createGithubRepo(
  pat: string,
  name: string,
  isPrivate: boolean
): Promise<{ owner: string; repo: string } | null> {
  const res = await fetch(`${BASE}/user/repos`, {
    method: 'POST',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
  if (!res.ok) return null;
  const d = await res.json();
  return { owner: d.owner.login, repo: d.name };
}

export async function checkRepoExists(pat: string, owner: string, repo: string): Promise<boolean> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}`, { headers: h(pat) });
  return res.ok;
}

export async function getDefaultBranchSha(
  pat: string,
  owner: string,
  repo: string
): Promise<{ branch: string; sha: string } | null> {
  const repoRes = await fetch(`${BASE}/repos/${owner}/${repo}`, { headers: h(pat) });
  if (!repoRes.ok) return null;
  const repoData = await repoRes.json();
  const defaultBranch: string = repoData.default_branch;

  const refRes = await fetch(`${BASE}/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, { headers: h(pat) });
  if (!refRes.ok) return null;
  const refData = await refRes.json();
  return { branch: defaultBranch, sha: refData.object?.sha };
}

export async function createBranchFromSha(
  pat: string,
  owner: string,
  repo: string,
  branch: string,
  sha: string
): Promise<boolean> {
  const res = await fetch(`${BASE}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  return res.ok;
}

export async function getFileSha(
  pat: string,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<string | null> {
  const res = await fetch(
    `${BASE}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { headers: h(pat) }
  );
  if (!res.ok) return null;
  const d = await res.json();
  return d.sha ?? null;
}

export async function pushFile(
  pat: string,
  owner: string,
  repo: string,
  path: string,
  base64Content: string,
  message: string,
  branch?: string,
  existingSha?: string
): Promise<boolean> {
  const body: Record<string, string> = { message, content: base64Content };
  if (branch) body.branch = branch;
  if (existingSha) body.sha = existingSha;

  const res = await fetch(`${BASE}/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...h(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

export function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const cleaned = input
    .replace(/^https?:\/\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .trim();
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}
