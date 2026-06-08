import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Plus, Trash2, Lock, Star, ChevronDown, ChevronRight, Clock, AlertTriangle, User, GitCommit } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, Branch } from '../types';
import { timeAgo } from '../lib/utils';
import {
  getGithubBranches, createGithubBranch, deleteGithubBranch, getGithubBranchCommits,
  getGitlabBranches, createGitlabBranch, deleteGitlabBranch,
} from '../lib/branches';

interface BranchesPageProps {
  projects: Project[];
  selectedProject: string | null;
  onSelectProject: (id: string) => void;
  onClearProject: () => void;
  githubPat: string;
  gitlabPat: string;
  onAddRepo?: (url: string) => Promise<void>;
}

interface CommitEntry { sha: string; message: string; author: string; date: string }

const STALE_DAYS = 30;

function isStale(date?: string): boolean {
  if (!date) return false;
  const age = Date.now() - new Date(date).getTime();
  return age > STALE_DAYS * 24 * 60 * 60 * 1000;
}

function BranchRow({
  branch, platform, pat, owner, repo, onDelete, deleting, confirmingDelete, onRequestDelete, onCancelDelete,
}: {
  branch: Branch;
  platform: string;
  pat: string;
  owner: string;
  repo: string;
  onDelete: (name: string) => void;
  deleting: boolean;
  confirmingDelete: boolean;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [expanded, setExpanded]             = useState(false);
  const [commits, setCommits]               = useState<CommitEntry[]>([]);
  const [loadingCommits, setLoadingCommits] = useState(false);

  const stale = isStale(branch.lastCommitDate);

  const toggleExpand = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (commits.length > 0 || platform === 'gitlab') return;
    setLoadingCommits(true);
    try {
      const data = await getGithubBranchCommits(pat, owner, repo, branch.name, 5);
      setCommits(data);
    } finally {
      setLoadingCommits(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      className={`border bg-[#0a0e1a]/40 ${stale && !branch.isDefault ? 'border-[#D4A574]/20' : 'border-[#CAAA98]/10'}`}
    >
      {/* Main row */}
      <div className="px-4 py-3 flex items-center gap-3">
        {/* Expand toggle — GitHub only (GitLab commits need extra API calls) */}
        {platform === 'github' ? (
          <button onClick={toggleExpand} className="text-[#9A8678]/30 hover:text-[#9A8678]/70 transition-colors flex-shrink-0">
            {expanded
              ? <ChevronDown className="w-3 h-3" strokeWidth={1.5} />
              : <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
            }
          </button>
        ) : (
          <div className="w-3 flex-shrink-0" />
        )}

        {/* Branch name + badges */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          {branch.isDefault && <Star className="w-3 h-3 text-[#D4A574] flex-shrink-0" strokeWidth={1.5} fill="#D4A574" />}
          {branch.protected && !branch.isDefault && <Lock className="w-3 h-3 text-[#9A8678]/40 flex-shrink-0" strokeWidth={1.5} />}
          <span className="font-mono text-xs text-[#CAAA98] truncate">{branch.name}</span>
          {branch.isDefault  && <span className="font-mono text-[8px] text-[#D4A574]/60 border border-[#D4A574]/20 px-1.5 py-0.5 flex-shrink-0">DEFAULT</span>}
          {branch.protected  && <span className="font-mono text-[8px] text-[#9A8678]/40 border border-[#9A8678]/20 px-1.5 py-0.5 flex-shrink-0">PROTECTED</span>}
          {stale && !branch.isDefault && (
            <span className="flex items-center gap-1 font-mono text-[8px] text-[#D4A574]/70 border border-[#D4A574]/20 px-1.5 py-0.5 flex-shrink-0">
              <AlertTriangle className="w-2 h-2" strokeWidth={2} /> STALE
            </span>
          )}
        </div>

        {/* Commit meta */}
        <div className="hidden lg:flex flex-col items-end gap-0.5 flex-shrink-0 min-w-0 max-w-[260px]">
          {branch.lastCommitMessage && (
            <div className="font-mono text-[9px] text-[#9A8678]/50 truncate max-w-full">{branch.lastCommitMessage}</div>
          )}
          <div className="flex items-center gap-3">
            {branch.lastCommitAuthor && (
              <div className="flex items-center gap-1 font-mono text-[8px] text-[#9A8678]/35">
                <User className="w-2 h-2" strokeWidth={1.5} />
                {branch.lastCommitAuthor}
              </div>
            )}
            {branch.lastCommitDate && (
              <div className="flex items-center gap-1 font-mono text-[8px] text-[#9A8678]/35">
                <Clock className="w-2 h-2" strokeWidth={1.5} />
                {timeAgo(branch.lastCommitDate)}
              </div>
            )}
          </div>
        </div>

        {/* SHA */}
        <span className="font-mono text-[9px] text-[#9A8678]/25 flex-shrink-0 hidden md:block">{branch.lastCommitSha}</span>

        {/* Delete controls */}
        {!branch.protected && !branch.isDefault && (
          confirmingDelete ? (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="font-mono text-[9px] text-[#A06A6A]/70">confirm?</span>
              <button
                onClick={() => onDelete(branch.name)} disabled={deleting}
                className="border border-[#A06A6A]/50 text-[#A06A6A] font-mono text-[9px] px-2 py-1 hover:bg-[#A06A6A]/10 transition-colors disabled:opacity-40"
              >{deleting ? '...' : 'YES'}</button>
              <button onClick={onCancelDelete} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">NO</button>
            </div>
          ) : (
            <button
              onClick={onRequestDelete}
              className="text-[#9A8678]/20 hover:text-[#A06A6A] transition-colors flex-shrink-0"
            ><Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} /></button>
          )
        )}
      </div>

      {/* Expandable commit history (GitHub only) */}
      <AnimatePresence>
        {expanded && platform === 'github' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="border-t border-[#CAAA98]/10 overflow-hidden"
          >
            {loadingCommits ? (
              <div className="px-10 py-3 font-mono text-[9px] text-[#9A8678]/40">loading commits...</div>
            ) : commits.length === 0 ? (
              <div className="px-10 py-3 font-mono text-[9px] text-[#9A8678]/40">no commits found</div>
            ) : (
              <div className="divide-y divide-[#CAAA98]/5">
                {commits.map((c, i) => (
                  <div key={i} className="px-10 py-2.5 flex items-center gap-3">
                    <GitCommit className="w-2.5 h-2.5 text-[#9A8678]/30 flex-shrink-0" strokeWidth={1.5} />
                    <span className="font-mono text-[8px] text-[#9A8678]/40 flex-shrink-0">{c.sha}</span>
                    <span className="font-mono text-[9px] text-[#CAAA98]/70 truncate flex-1">{c.message}</span>
                    <span className="font-mono text-[8px] text-[#9A8678]/35 flex-shrink-0">{c.author}</span>
                    <span className="font-mono text-[8px] text-[#9A8678]/30 flex-shrink-0">{c.date ? timeAgo(c.date) : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function BranchesPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, onAddRepo }: BranchesPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [branches, setBranches]         = useState<Branch[]>([]);
  const [loading, setLoading]           = useState(false);
  const [showForm, setShowForm]         = useState(false);
  const [newName, setNewName]           = useState('');
  const [fromBranch, setFromBranch]     = useState('');
  const [creating, setCreating]         = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    try {
      const data = platform === 'gitlab'
        ? await getGitlabBranches(pat, project.owner, project.repoName)
        : await getGithubBranches(pat, project.owner, project.repoName);
      setBranches(data.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)));
    } finally {
      setLoading(false);
    }
  }, [project, pat, platform]);

  useEffect(() => { setBranches([]); load(); }, [load]);

  useEffect(() => {
    if (branches.length && !fromBranch) {
      const def = branches.find(b => b.isDefault);
      setFromBranch(def?.name ?? branches[0]?.name ?? '');
    }
  }, [branches, fromBranch]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);

  const staleCount = branches.filter(b => !b.isDefault && isStale(b.lastCommitDate)).length;

  const handleCreate = async () => {
    if (!newName.trim() || !fromBranch.trim() || !project.owner || !project.repoName) return;
    setCreating(true);
    const ok = platform === 'gitlab'
      ? await createGitlabBranch(pat, project.owner, project.repoName, newName.trim(), fromBranch.trim())
      : await createGithubBranch(pat, project.owner, project.repoName, newName.trim(), fromBranch.trim());
    if (ok) { setNewName(''); setShowForm(false); setTimeout(load, 800); }
    setCreating(false);
  };

  const handleDelete = async (name: string) => {
    if (!project.owner || !project.repoName) return;
    setDeletingName(name);
    const ok = platform === 'gitlab'
      ? await deleteGitlabBranch(pat, project.owner, project.repoName, name)
      : await deleteGithubBranch(pat, project.owner, project.repoName, name);
    if (ok) setBranches(prev => prev.filter(b => b.name !== name));
    setDeletingName(null);
    setConfirmDelete(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">BRANCH_MANAGER</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
              {!loading && branches.length > 0 && (
                <div className="font-mono text-[9px] text-[#9A8678]/40">{branches.length} branches</div>
              )}
              {staleCount > 0 && (
                <div className="flex items-center gap-1 font-mono text-[9px] text-[#D4A574]/60 border border-[#D4A574]/20 px-2 py-0.5">
                  <AlertTriangle className="w-2.5 h-2.5" strokeWidth={2} />
                  {staleCount} stale (&gt;{STALE_DAYS}d)
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowForm(v => !v)}
              className="flex items-center gap-1.5 border border-[#CAAA98]/30 text-[#CAAA98] font-mono text-[10px] px-3 py-1.5 hover:bg-[#CAAA98]/10 transition-colors"
            ><Plus className="w-3 h-3" strokeWidth={2} /> NEW BRANCH</button>
            <button onClick={load} disabled={loading}
              className="border border-[#9A8678]/30 text-[#9A8678] p-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
            ><RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /></button>
          </div>
        </div>

        {!isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">REPO_NOT_CONNECTED</div>}
        {!pat && isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">{platform.toUpperCase()}_PAT not set — add it in settings</div>}

        {platform === 'github' && isConnected && (
          <div className="mb-4 font-mono text-[9px] text-[#9A8678]/35 border border-[#9A8678]/10 px-3 py-2">
            Click the <ChevronRight className="w-2.5 h-2.5 inline" strokeWidth={1.5} /> arrow on any branch to view recent commit history
          </div>
        )}

        {/* Create branch form */}
        <AnimatePresence>
          {showForm && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 border border-[#CAAA98]/20 bg-[#0a0e1a]/50 p-4 space-y-3 overflow-hidden"
            >
              <div className="flex gap-2">
                <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="new-branch-name"
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
                />
                <div className="font-mono text-[10px] text-[#9A8678]/40 flex items-center px-2">from</div>
                <select value={fromBranch} onChange={e => setFromBranch(e.target.value)}
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60"
                >
                  {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
                </select>
              </div>
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={!newName.trim() || creating}
                  className="border border-[#CAAA98]/50 text-[#CAAA98] font-mono text-[10px] px-4 py-1.5 hover:bg-[#CAAA98]/10 transition-colors disabled:opacity-40"
                >{creating ? 'CREATING...' : 'CREATE_BRANCH'}</button>
                <button onClick={() => setShowForm(false)} className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[10px] px-3 py-1.5 hover:border-[#9A8678]/40 transition-colors">CANCEL</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Branch list */}
        <div className="space-y-1.5">
          {loading && branches.length === 0 && (
            <div className="font-mono text-[10px] text-[#9A8678]/40">
              loading{platform === 'github' ? ' + fetching commit details...' : '...'}
            </div>
          )}
          {!loading && branches.length === 0 && pat && isConnected && (
            <div className="font-mono text-[10px] text-[#9A8678]/40">NO_BRANCHES found</div>
          )}
          {branches.map(branch => (
            <BranchRow
              key={branch.name}
              branch={branch}
              platform={platform}
              pat={pat}
              owner={project.owner!}
              repo={project.repoName!}
              onDelete={handleDelete}
              deleting={deletingName === branch.name}
              confirmingDelete={confirmDelete === branch.name}
              onRequestDelete={() => setConfirmDelete(branch.name)}
              onCancelDelete={() => setConfirmDelete(null)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
