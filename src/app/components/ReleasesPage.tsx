import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RefreshCw, Plus, Tag, Trash2 } from 'lucide-react';
import { RepoSelector } from './RepoSelector';
import { Project, Release } from '../types';
import { timeAgo } from '../lib/utils';
import {
  getGithubReleases, createGithubRelease, deleteGithubRelease,
  getGitlabReleases, createGitlabRelease,
} from '../lib/releases';

interface ReleasesPageProps {
  projects: Project[];
  selectedProject: string | null;
  onSelectProject: (id: string) => void;
  onClearProject: () => void;
  githubPat: string;
  gitlabPat: string;
  onAddRepo?: (url: string) => Promise<void>;
}

export function ReleasesPage({ projects, selectedProject, onSelectProject, onClearProject, githubPat, gitlabPat, onAddRepo }: ReleasesPageProps) {
  const project = projects.find(p => p.id === selectedProject);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ tag: '', name: '', body: '', prerelease: false });
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const platform = project?.platform ?? 'github';
  const pat = platform === 'gitlab' ? gitlabPat : githubPat;

  const load = useCallback(async () => {
    if (!project?.owner || !project?.repoName || !pat) return;
    setLoading(true);
    try {
      const data = platform === 'gitlab'
        ? await getGitlabReleases(pat, project.owner, project.repoName)
        : await getGithubReleases(pat, project.owner, project.repoName);
      setReleases(data);
    } finally {
      setLoading(false);
    }
  }, [project, pat, platform]);

  useEffect(() => { setReleases([]); load(); }, [load]);

  if (!project) return <RepoSelector projects={projects} onSelect={onSelectProject} onAddRepo={onAddRepo} />;

  const isConnected = !!(project.owner && project.repoName);

  const handleCreate = async () => {
    if (!form.tag.trim() || !project.owner || !project.repoName) return;
    setCreating(true);
    const created = platform === 'gitlab'
      ? await createGitlabRelease(pat, project.owner, project.repoName, form.tag, form.name || form.tag, form.body)
      : await createGithubRelease(pat, project.owner, project.repoName, form.tag, form.name || form.tag, form.body, form.prerelease);
    if (created) { setReleases(prev => [created, ...prev]); setForm({ tag: '', name: '', body: '', prerelease: false }); setShowForm(false); }
    setCreating(false);
  };

  const handleDelete = async (id: number) => {
    if (!project.owner || !project.repoName || platform === 'gitlab') return;
    setDeletingId(id);
    const ok = await deleteGithubRelease(pat, project.owner, project.repoName, id);
    if (ok) setReleases(prev => prev.filter(r => r.id !== id));
    setDeletingId(null);
    setConfirmDelete(null);
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-1">RELEASE_MANAGER</div>
            <div className="flex items-center gap-3">
              <div className="font-mono text-sm text-[#CAAA98]">{project.name}</div>
              <button onClick={onClearProject} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">[ CHANGE ]</button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowForm(v => !v)}
              className="flex items-center gap-1.5 border border-[#CAAA98]/30 text-[#CAAA98] font-mono text-[10px] px-3 py-1.5 hover:bg-[#CAAA98]/10 transition-colors"
            ><Plus className="w-3 h-3" strokeWidth={2} /> NEW RELEASE</button>
            <button onClick={load} disabled={loading}
              className="border border-[#9A8678]/30 text-[#9A8678] p-1.5 hover:border-[#CAAA98]/40 hover:text-[#CAAA98] transition-colors disabled:opacity-40"
            ><RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} /></button>
          </div>
        </div>

        {!isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">REPO_NOT_CONNECTED</div>}
        {!pat && isConnected && <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">{platform.toUpperCase()}_PAT not set — add it in settings</div>}

        <AnimatePresence>
          {showForm && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 border border-[#CAAA98]/20 bg-[#0a0e1a]/50 p-4 space-y-3 overflow-hidden"
            >
              <div className="flex gap-2">
                <input value={form.tag} onChange={e => setForm(f => ({ ...f, tag: e.target.value }))} placeholder="v1.0.0  (tag)"
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
                />
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Release title (optional)"
                  className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30"
                />
              </div>
              <textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} placeholder="Release notes (optional)" rows={4}
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/30 resize-none"
              />
              {platform === 'github' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.prerelease} onChange={e => setForm(f => ({ ...f, prerelease: e.target.checked }))} className="accent-[#D4A574]" />
                  <span className="font-mono text-[10px] text-[#9A8678]/60">Mark as pre-release</span>
                </label>
              )}
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={!form.tag.trim() || creating}
                  className="border border-[#CAAA98]/50 text-[#CAAA98] font-mono text-[10px] px-4 py-1.5 hover:bg-[#CAAA98]/10 transition-colors disabled:opacity-40"
                >{creating ? 'PUBLISHING...' : 'PUBLISH_RELEASE'}</button>
                <button onClick={() => setShowForm(false)} className="border border-[#9A8678]/20 text-[#9A8678]/50 font-mono text-[10px] px-3 py-1.5 hover:border-[#9A8678]/40 transition-colors">CANCEL</button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-2">
          {loading && releases.length === 0 && <div className="font-mono text-[10px] text-[#9A8678]/40">loading...</div>}
          {!loading && releases.length === 0 && pat && isConnected && <div className="font-mono text-[10px] text-[#9A8678]/40">NO_RELEASES found</div>}
          {releases.map(rel => (
            <motion.div key={rel.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
              className="border border-[#CAAA98]/10 bg-[#0a0e1a]/40 p-4"
            >
              <div className="flex items-start gap-3">
                <Tag className="w-3.5 h-3.5 text-[#9A8678]/40 flex-shrink-0 mt-0.5" strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <a href={rel.url} target="_blank" rel="noopener noreferrer"
                      className="font-mono text-xs text-[#CAAA98] hover:text-[#CAAA98]/80 transition-colors"
                    >{rel.name || rel.tag}</a>
                    <span className="font-mono text-[9px] text-[#9A8678]/40 border border-[#9A8678]/20 px-1.5 py-0.5">{rel.tag}</span>
                    {rel.draft && <span className="font-mono text-[8px] text-[#9A8678]/40 border border-[#9A8678]/20 px-1.5 py-0.5">DRAFT</span>}
                    {rel.prerelease && <span className="font-mono text-[8px] text-[#D4A574]/60 border border-[#D4A574]/20 px-1.5 py-0.5">PRE-RELEASE</span>}
                  </div>
                  {rel.body && <div className="font-mono text-[9px] text-[#9A8678]/50 mt-1.5 line-clamp-2">{rel.body}</div>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="font-mono text-[9px] text-[#9A8678]/30">{timeAgo(rel.createdAt)}</span>
                  {platform === 'github' && (
                    confirmDelete === rel.id ? (
                      <div className="flex items-center gap-1">
                        <button onClick={() => handleDelete(rel.id)} disabled={deletingId === rel.id}
                          className="border border-[#A06A6A]/50 text-[#A06A6A] font-mono text-[9px] px-2 py-1 hover:bg-[#A06A6A]/10 transition-colors disabled:opacity-40"
                        >{deletingId === rel.id ? '...' : 'DELETE'}</button>
                        <button onClick={() => setConfirmDelete(null)} className="font-mono text-[9px] text-[#9A8678]/40 hover:text-[#9A8678] px-1">✕</button>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDelete(rel.id)} className="text-[#9A8678]/20 hover:text-[#A06A6A] transition-colors">
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    )
                  )}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
