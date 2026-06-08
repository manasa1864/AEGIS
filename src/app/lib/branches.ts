import { Branch } from '../types';

const GH = 'https://api.github.com';
const GL = 'https://gitlab.com/api/v4';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
function glH(pat: string): HeadersInit {
  return { 'PRIVATE-TOKEN': pat, 'Content-Type': 'application/json' };
}
function pid(o: string, r: string) { return encodeURIComponent(`${o}/${r}`); }

// ── GitHub Branches ───────────────────────────────────────────────────────────

export async function getGithubBranches(pat: string, owner: string, repo: string): Promise<Branch[]> {
  const [branchRes, repoRes] = await Promise.all([
    fetch(`${GH}/repos/${owner}/${repo}/branches?per_page=50`, { headers: ghH(pat) }),
    fetch(`${GH}/repos/${owner}/${repo}`, { headers: ghH(pat) }),
  ]);
  if (!branchRes.ok) return [];
  const branches: Record<string, unknown>[] = await branchRes.json();
  const defaultBranch = repoRes.ok ? (await repoRes.json()).default_branch : 'main';

  // Enrich each branch with full commit details (author, date, message) in parallel
  const enriched = await Promise.all(
    (Array.isArray(branches) ? branches : []).map(async (b) => {
      const sha = (b.commit as Record<string, string>)?.sha ?? '';
      let lastCommitDate = '';
      let lastCommitAuthor = '';
      let lastCommitMessage = '';

      if (sha) {
        try {
          const commitRes = await fetch(`${GH}/repos/${owner}/${repo}/git/commits/${sha}`, { headers: ghH(pat) });
          if (commitRes.ok) {
            const c = await commitRes.json();
            lastCommitDate    = c.author?.date ?? '';
            lastCommitAuthor  = c.author?.name ?? '';
            lastCommitMessage = (c.message as string)?.split('\n')[0] ?? '';
          }
        } catch { /* skip if commit detail fetch fails */ }
      }

      return {
        name: b.name as string,
        protected: b.protected as boolean,
        isDefault: b.name === defaultBranch,
        lastCommitSha: sha.slice(0, 7),
        lastCommitDate,
        lastCommitAuthor,
        lastCommitMessage,
      } satisfies Branch;
    })
  );

  return enriched;
}

export async function createGithubBranch(pat: string, owner: string, repo: string, name: string, fromBranch: string): Promise<boolean> {
  const refRes = await fetch(`${GH}/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`, { headers: ghH(pat) });
  if (!refRes.ok) return false;
  const sha = (await refRes.json()).object?.sha;
  if (!sha) return false;
  const res = await fetch(`${GH}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers: { ...ghH(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha }),
  });
  return res.ok;
}

export async function deleteGithubBranch(pat: string, owner: string, repo: string, branch: string): Promise<boolean> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'DELETE', headers: ghH(pat) });
  return res.ok || res.status === 204;
}

// New: fetch last N commits on a branch
export async function getGithubBranchCommits(
  pat: string, owner: string, repo: string, branch: string, perPage = 5
): Promise<Array<{ sha: string; message: string; author: string; date: string }>> {
  const res = await fetch(
    `${GH}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
    { headers: ghH(pat) }
  );
  if (!res.ok) return [];
  const data: Record<string, unknown>[] = await res.json();
  return (Array.isArray(data) ? data : []).map(c => {
    const commit = c.commit as Record<string, unknown>;
    const author = commit?.author as Record<string, string> ?? {};
    return {
      sha: (c.sha as string)?.slice(0, 7) ?? '',
      message: (commit?.message as string)?.split('\n')[0] ?? '',
      author: author.name ?? (c.author as Record<string, string>)?.login ?? 'unknown',
      date: author.date ?? '',
    };
  });
}

// ── GitLab Branches ───────────────────────────────────────────────────────────

export async function getGitlabBranches(pat: string, owner: string, repo: string): Promise<Branch[]> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/repository/branches?per_page=50`, { headers: glH(pat) });
  if (!res.ok) return [];
  const data: Record<string, unknown>[] = await res.json();
  // GitLab includes full commit info inline — no extra requests needed
  return (Array.isArray(data) ? data : []).map(b => {
    const c = b.commit as Record<string, unknown> ?? {};
    return {
      name: b.name as string,
      protected: b.protected as boolean,
      isDefault: b.default as boolean,
      lastCommitSha: c.short_id as string ?? '',
      lastCommitDate: (c.authored_date ?? c.committed_date) as string ?? '',
      lastCommitAuthor: c.author_name as string ?? '',
      lastCommitMessage: (c.message as string)?.split('\n')[0] ?? '',
    } satisfies Branch;
  });
}

export async function createGitlabBranch(pat: string, owner: string, repo: string, name: string, fromBranch: string): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/repository/branches`, {
    method: 'POST', headers: glH(pat),
    body: JSON.stringify({ branch: name, ref: fromBranch }),
  });
  return res.ok;
}

export async function deleteGitlabBranch(pat: string, owner: string, repo: string, branch: string): Promise<boolean> {
  const res = await fetch(`${GL}/projects/${pid(owner, repo)}/repository/branches/${encodeURIComponent(branch)}`, { method: 'DELETE', headers: glH(pat) });
  return res.ok || res.status === 204;
}
