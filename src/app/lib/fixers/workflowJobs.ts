// Job-level view of a GitHub Actions workflow — which directory each job runs
// in and which runtime versions it sets up — with the line ranges needed to
// edit a job in place without reformatting the rest of the file.

import { isGitHubWorkflow } from './helpers';

type Files = Array<{ path: string; content: string }>;

export interface WorkflowJob {
  path: string;               // workflow file
  id: string;                 // job id
  start: number;              // line index of the `id:` header
  end: number;                // exclusive
  /** Directory the job's run steps execute in ('' = repo root). */
  workingDirectory: string;
  /** `node-version:` / `python-version:` values set up by the job, with their line index. */
  nodeVersions: Array<{ line: number; value: string }>;
  pythonVersions: Array<{ line: number; value: string }>;
  /** Text of every `run:` command in the job. */
  runs: string[];
}

const indentOf = (l: string) => l.length - l.trimStart().length;
const unquote = (v: string) => v.trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
export const normDir = (d: string) => unquote(d).replace(/^\.\/?/, '').replace(/\/+$/, '');

export function workflowJobs(path: string, content: string): WorkflowJob[] {
  const lines = content.split('\n');
  const jobsAt = lines.findIndex(l => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return [];
  // Workflow-level `defaults: run: working-directory:` applies to every job.
  let workflowDir = '';
  for (let i = 0; i < jobsAt; i++) {
    const m = lines[i].match(/^\s+working-directory:\s*(.+)$/);
    if (m && /^defaults:/m.test(lines.slice(0, i).join('\n'))) workflowDir = normDir(m[1]);
  }

  const jobs: WorkflowJob[] = [];
  let jobIndent = -1;
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const ind = indentOf(line);
    if (ind === 0) break; // next top-level key
    if (jobIndent < 0) jobIndent = ind;
    if (ind !== jobIndent) continue;
    const m = line.match(/^\s*([\w-]+):\s*(#.*)?$/);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > jobIndent)) end++;
    jobs.push(scanJob(path, m[1], i, end, lines, workflowDir));
    i = end - 1;
  }
  return jobs;
}

function scanJob(path: string, id: string, start: number, end: number, lines: string[], workflowDir: string): WorkflowJob {
  const job: WorkflowJob = { path, id, start, end, workingDirectory: workflowDir, nodeVersions: [], pythonVersions: [], runs: [] };
  const stepDirs: string[] = [];
  let inDefaults = -1;
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    const ind = indentOf(l);
    if (inDefaults >= 0 && l.trim() && ind <= inDefaults) inDefaults = -1;
    if (/^\s*defaults:\s*$/.test(l)) inDefaults = ind;
    let m = l.match(/^\s*working-directory:\s*(.+)$/);
    if (m) {
      if (inDefaults >= 0) job.workingDirectory = normDir(m[1]);
      else stepDirs.push(normDir(m[1]));
    }
    if ((m = l.match(/^\s*node-version:\s*(.+)$/))) job.nodeVersions.push({ line: i, value: unquote(m[1]) });
    if ((m = l.match(/^\s*python-version:\s*(.+)$/))) job.pythonVersions.push({ line: i, value: unquote(m[1]) });
    if ((m = l.match(/^\s*(?:-\s+)?run:\s*(.*)$/))) {
      if (/^[|>][-+]?\s*$/.test(m[1])) {
        const body: string[] = [];
        const bodyIndent = ind + 2;
        for (let j = i + 1; j < end && (!lines[j].trim() || indentOf(lines[j]) >= bodyIndent); j++) body.push(lines[j].trim());
        job.runs.push(body.join('\n'));
      } else job.runs.push(m[1].trim());
    }
  }
  // A job whose steps all share one working-directory effectively runs there.
  if (!job.workingDirectory && stepDirs.length && stepDirs.every(d => d === stepDirs[0])) job.workingDirectory = stepDirs[0];
  return job;
}

/** Every job across the GitHub workflows in `files`. */
export function allWorkflowJobs(files: Files): WorkflowJob[] {
  return files.filter(f => isGitHubWorkflow(f.path)).flatMap(f => workflowJobs(f.path, f.content));
}

/** Distinct non-root directories CI jobs run in — where their manifests live. */
export function jobDirectories(files: Files): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!isGitHubWorkflow(f.path) && !/gitlab-ci/.test(f.path)) continue;
    for (const m of f.content.matchAll(/working-directory:\s*(.+)/g)) dirs.add(normDir(m[1]));
    for (const m of f.content.matchAll(/(?:^|[\s;&])cd\s+([\w./-]+)\s*(?:&&|;|$)/gm)) dirs.add(normDir(m[1]));
  }
  dirs.delete('');
  return [...dirs].filter(d => !d.includes('$') && !d.startsWith('/') && !d.startsWith('..'));
}

export const joinPath = (dir: string, file: string) => (dir ? `${dir}/${file}` : file).replace(/^\.\//, '');
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** The manifest (package.json, requirements.txt…) governing `path`: the nearest one at or above its directory. */
export function nearestFile<T extends { path: string }>(files: T[], fromPath: string, name: RegExp): T | undefined {
  let dir = dirOf(fromPath);
  for (;;) {
    const hit = files.find(f => dirOf(f.path) === dir && name.test(f.path.slice(dir ? dir.length + 1 : 0)));
    if (hit) return hit;
    if (!dir) return undefined;
    dir = dirOf(dir);
  }
}
