export type SystemStatus = 'idle' | 'healing' | 'stopped' | 'healthy';

export type View = 'healing' | 'history' | 'intelligence';

export interface Project {
  id: string;
  name: string;
  errorType: string;
  repo: string;
  severity: 'high' | 'medium' | 'low';
  githubUrl?: string;
  owner?: string;
  repoName?: string;
  platform?: 'github' | 'gitlab';
  category?: string;
  healingStatus?: 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_ERROR';
  stars?: number;
  forks?: number;
  language?: string;
  openIssues?: number;
  description?: string;
}

export interface HealingEventRecord {
  id: number;
  pipeline_id: string;
  project_name: string;
  branch: string;
  provider: string;
  failed_stage?: string;
  root_cause?: string;
  severity?: string;
  auto_healable?: boolean;
  fix_steps?: string[];
  estimated_time?: string;
  status: 'healing' | 'healed' | 'failed';
  confidence?: number;
  ranked_fixes?: { description: string; confidence: number; risk: string }[];
  postmortem?: string;
  recovery_time_ms?: number;
  sources?: Array<{ title: string; url: string }>;
  created_at: string;
}

export interface MetricsData {
  total: number;
  healed: number;
  failed: number;
  healing: number;
  success_rate: number;
  avg_recovery_ms: number;
  avg_confidence: number | null;
  by_provider: Record<string, number>;
  by_severity: Record<string, number>;
  by_project: Record<string, { healed: number; failed: number; healing?: number; total?: number }>;
  recent: HealingEventRecord[];
}

export interface SelectedFile {
  file: File;
  relativePath: string;
}

export interface PushLogEntry {
  id: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

export interface CIRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  branch: string;
  commitMsg: string;
  url: string;
  createdAt: string;
}

export interface CIPipeline {
  id: number;
  status: string;
  ref: string;
  url: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  url: string;
  createdAt: string;
  labels: string[];
  author: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  url: string;
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  author: string;
  draft: boolean;
}

export interface Branch {
  name: string;
  protected: boolean;
  isDefault: boolean;
  lastCommitSha: string;
  lastCommitDate?: string;
  lastCommitAuthor?: string;
  lastCommitMessage?: string;
}

export interface Release {
  id: number;
  tag: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  url: string;
  createdAt: string;
}

export interface SecurityAlert {
  id: number;
  severity: string;
  description: string;
  package?: string;
  url: string;
  type: 'dependabot' | 'secret' | 'code';
}
