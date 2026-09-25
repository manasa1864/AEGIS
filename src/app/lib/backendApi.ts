const BASE = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// ── Token helpers ─────────────────────────────────────────────────────────────

export function getToken(): string | null {
  return localStorage.getItem('aegis_token');
}

export function saveToken(token: string) {
  localStorage.setItem('aegis_token', token);
}

export function clearToken() {
  localStorage.removeItem('aegis_token');
}

// Fired whenever the backend rejects our JWT. App listens and returns to the
// login screen — otherwise an expired token leaves the dashboard up with
// every request silently failing.
export const SESSION_EXPIRED_EVENT = 'aegis:session-expired';

function expireSession(): never {
  clearToken();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  throw new Error('SESSION_EXPIRED');
}

/** Parse a JSON body, tolerating HTML/empty error pages (proxy 502s, crashes). */
async function readJson(res: Response): Promise<Record<string, any>> {
  return res.json().catch(() => ({ error: `Unexpected response from backend (HTTP ${res.status})` }));
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function networkErrMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'Failed to fetch' || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
    return 'Backend not running — start it with: cd backend && python run.py';
  }
  return msg;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function apiRegister(email: string, password: string, name: string) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || 'Registration failed');
  return data as { token: string; user: { id: number; name: string; email: string } };
}

export async function apiLogin(email: string, password: string) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  const data = await readJson(res);
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data as { token: string; user: { id: number; name: string; email: string } };
}

// ── Repos ─────────────────────────────────────────────────────────────────────

export async function apiGetRepos() {
  let res: Response;
  try { res = await fetch(`${BASE}/api/repos`, { headers: authHeaders() }); }
  catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) throw new Error('Failed to load repos');
  return res.json();
}

export async function apiAddRepo(repo: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/repos`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(repo),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401 || res.status === 422) expireSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; msg?: string };
    throw new Error(err.error || err.msg || `Save failed (HTTP ${res.status})`);
  }
  return res.json();
}

export async function apiUpdateRepo(id: string, patch: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/repos/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) throw new Error('Failed to update repo');
  return res.json();
}

export async function apiDeleteRepo(id: string) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/repos/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) throw new Error('Failed to delete repo');
  return res.json();
}

// ── Healing Events ────────────────────────────────────────────────────────────

export async function apiCreateEvent(event: {
  pipeline_id: string | number;
  project_name: string;
  branch: string;
  provider: string;
  failed_stage?: string;
  status?: string;
}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/events`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(event),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Event create failed (HTTP ${res.status})`);
  }
  return res.json() as Promise<{ id: number }>;
}

export async function apiUpdateEvent(id: number, patch: {
  status?: string;
  fix_steps?: string[];
  root_cause?: string;
  confidence?: number;
  ranked_fixes?: { description: string; confidence: number; risk: string }[];
  postmortem?: string;
  recovery_time_ms?: number;
  sources?: Array<{ title: string; url: string }>;
}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/events/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error || `Event update failed (HTTP ${res.status})`);
  }
}

export async function apiGetEvents(projectName?: string) {
  let res: Response;
  try {
    const qs = projectName ? `?project=${encodeURIComponent(projectName)}` : '';
    res = await fetch(`${BASE}/api/events${qs}`, { headers: authHeaders() });
  } catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) throw new Error(`Failed to load events (HTTP ${res.status})`);
  return res.json();
}

export async function apiGetMetrics() {
  let res: Response;
  try { res = await fetch(`${BASE}/api/metrics`, { headers: authHeaders() }); }
  catch (e) { throw new Error(networkErrMsg(e), { cause: e }); }
  if (res.status === 401) expireSession();
  if (!res.ok) throw new Error(`Metrics load failed (HTTP ${res.status})`);
  return res.json();
}
