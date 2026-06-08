import { SecurityAlert } from '../types';

const GH = 'https://api.github.com';

function ghH(pat: string): HeadersInit {
  return { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

// ── GitHub Security Alerts ────────────────────────────────────────────────────
// All three require the `security_events` scope on the PAT.
// 403 = missing scope, 404 = feature disabled on that repo.

export async function getDependabotAlerts(pat: string, owner: string, repo: string): Promise<SecurityAlert[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/dependabot/alerts?state=open&per_page=30`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((a: Record<string, unknown>) => ({
    id: a.number as number,
    type: 'dependabot' as const,
    severity: (a.security_advisory as Record<string, string>)?.severity ?? 'medium',
    description: (a.security_advisory as Record<string, string>)?.summary ?? (a.dependency as Record<string, Record<string, string>>)?.package?.name ?? 'unknown',
    package: (a.dependency as Record<string, Record<string, string>>)?.package?.name,
    url: a.html_url as string,
  }));
}

export async function getSecretScanningAlerts(pat: string, owner: string, repo: string): Promise<SecurityAlert[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/secret-scanning/alerts?state=open&per_page=30`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((a: Record<string, unknown>) => ({
    id: a.number as number,
    type: 'secret' as const,
    severity: 'high',
    description: (a.secret_type_display_name ?? a.secret_type ?? 'Secret detected') as string,
    url: a.html_url as string,
  }));
}

export async function getCodeScanningAlerts(pat: string, owner: string, repo: string): Promise<SecurityAlert[]> {
  const res = await fetch(`${GH}/repos/${owner}/${repo}/code-scanning/alerts?state=open&per_page=30`, { headers: ghH(pat) });
  if (!res.ok) return [];
  const d = await res.json();
  return (Array.isArray(d) ? d : []).map((a: Record<string, unknown>) => ({
    id: a.number as number,
    type: 'code' as const,
    severity: (a.rule as Record<string, string>)?.security_severity_level ?? (a.rule as Record<string, string>)?.severity ?? 'medium',
    description: (a.rule as Record<string, string>)?.description ?? (a.rule as Record<string, string>)?.id ?? 'Code vulnerability',
    url: a.html_url as string,
  }));
}
