// Shared types for the healing strategies (see ladder.ts for the order they run in).

export type Platform = 'github' | 'gitlab';

export interface RepoFile { path: string; content: string; sha?: string }

export interface ProposedFix { path: string; content: string; explanation: string; sha?: string }

/** A failing CI run: GitHub workflow run, or GitLab pipeline. */
export interface FailingRun { id: number; name: string; workflowId?: number; headSha?: string }

export interface StrategyContext {
  platform: Platform;
  pat: string;
  owner: string;
  repo: string;
  /** Branch whose CI is failing — also the base for fix / revert PRs. */
  branch: string;
  failingRuns: FailingRun[];
  log: (message: string, kind?: 'info' | 'attempt' | 'ok' | 'fail') => void;
  isCancelled: () => boolean;
}

export type StrategyId = 'memory' | 'rules' | 'flaky' | 'autofix' | 'ai' | 'revert';
