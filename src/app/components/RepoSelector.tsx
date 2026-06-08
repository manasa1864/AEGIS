import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { GitBranch, Plus, X } from 'lucide-react';
import { Project } from '../types';

interface RepoSelectorProps {
  projects: Project[];
  onSelect: (id: string) => void;
  onAddRepo?: (url: string) => Promise<void>;
}

export function RepoSelector({ projects, onSelect, onAddRepo }: RepoSelectorProps) {
  const [showForm, setShowForm]   = useState(false);
  const [url, setUrl]             = useState('');
  const [adding, setAdding]       = useState(false);
  const [error, setError]         = useState('');

  const handleAdd = async () => {
    if (!url.trim() || !onAddRepo) return;
    setAdding(true);
    setError('');
    try {
      await onAddRepo(url.trim());
      setUrl('');
      setShowForm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add repository');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-6">SELECT_REPOSITORY_TO_CONTINUE</div>

      {projects.length === 0 ? (
        <div className="font-mono text-[10px] text-[#9A8678]/40 mb-4">
          NO_REPOSITORIES — add one below or via the HEALING tab
        </div>
      ) : (
        <div className="flex flex-col gap-2 w-full max-w-md mb-4">
          {projects.map(p => (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              className="border border-[#CAAA98]/15 bg-[#0a0e1a]/50 p-4 text-left hover:border-[#CAAA98]/45 hover:bg-[#0a0e1a]/70 transition-all flex items-center gap-3"
            >
              <GitBranch className="w-3 h-3 text-[#9A8678]/40 flex-shrink-0" strokeWidth={1.5} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-xs text-[#CAAA98]">{p.name}</div>
                <div className="font-mono text-[9px] text-[#9A8678]/40 mt-0.5">{p.platform ?? 'github'} · {p.repo}</div>
              </div>
              {p.platform === 'gitlab' && (
                <div className="font-mono text-[8px] text-[#9A8678]/40 border border-[#9A8678]/20 px-1.5 py-0.5 flex-shrink-0">GL</div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Inline add-repo form (only shown when onAddRepo is wired up) */}
      {onAddRepo && (
        <div className="w-full max-w-md">
          <AnimatePresence>
            {showForm ? (
              <motion.div
                key="form"
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                className="border border-[#CAAA98]/20 bg-[#0a0e1a]/60 p-4 overflow-hidden"
              >
                <div className="font-mono text-[9px] text-[#9A8678]/60 tracking-widest mb-3">CONNECT_REPOSITORY</div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowForm(false); }}
                    placeholder="github.com/owner/repo  or  gitlab.com/owner/repo"
                    autoFocus
                    disabled={adding}
                    className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 font-mono text-xs focus:outline-none focus:border-[#CAAA98]/60 placeholder:text-[#9A8678]/25 disabled:opacity-50"
                  />
                  <button
                    onClick={handleAdd}
                    disabled={adding || !url.trim()}
                    className="px-4 py-2 border border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] font-mono text-[10px] tracking-widest hover:bg-[#CAAA98]/20 transition-all disabled:opacity-40"
                  >
                    {adding ? '...' : 'ADD'}
                  </button>
                  <button onClick={() => { setShowForm(false); setUrl(''); setError(''); }} className="p-2 text-[#9A8678]/40 hover:text-[#9A8678]">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {error && <div className="font-mono text-[9px] text-[#A06A6A] mt-2">{error}</div>}
              </motion.div>
            ) : (
              <motion.button
                key="btn"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setShowForm(true)}
                className="w-full flex items-center justify-center gap-2 border border-dashed border-[#CAAA98]/20 py-3 font-mono text-[10px] text-[#9A8678]/40 hover:text-[#CAAA98]/70 hover:border-[#CAAA98]/40 transition-all tracking-wider"
              >
                <Plus className="w-3 h-3" strokeWidth={2} />
                ADD_REPOSITORY
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
