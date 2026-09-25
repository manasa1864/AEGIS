import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, X, FolderPlus, ChevronDown, ChevronRight } from 'lucide-react';
import { Project } from '../types';
import { RepoCard } from './RepoCard';

interface RepoListViewProps {
  projects: Project[];
  showAddRepo: boolean;
  newRepoUrl: string;
  addingRepo: boolean;
  addRepoError?: string;
  anyPatSet: boolean;
  onToggleAddRepo: () => void;
  onNewRepoUrlChange: (url: string) => void;
  onAddRepo: () => void;
  onSelectProject: (id: string) => void;
  onRemoveProject: (id: string) => void;
  onSetCategory: (id: string, category: string) => void;
}

export function RepoListView({
  projects, showAddRepo, newRepoUrl, addingRepo, addRepoError, anyPatSet,
  onToggleAddRepo, onNewRepoUrlChange, onAddRepo,
  onSelectProject, onRemoveProject, onSetCategory,
}: RepoListViewProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);

  // Group projects by category — uncategorized repos go into "UNCATEGORIZED"
  const grouped = projects.reduce<Record<string, Project[]>>((acc, p) => {
    const cat = p.category?.trim() || 'UNCATEGORIZED';
    (acc[cat] = acc[cat] || []).push(p);
    return acc;
  }, {});

  // Named categories first (alphabetical), UNCATEGORIZED last
  const categories = Object.keys(grouped).sort((a, b) => {
    if (a === 'UNCATEGORIZED') return 1;
    if (b === 'UNCATEGORIZED') return -1;
    return a.localeCompare(b);
  });

  const toggleCategory = (cat: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const handleCreateCategory = () => {
    const name = newCategoryName.trim().toUpperCase();
    if (!name) return;
    setNewCategoryName('');
    setShowNewCategory(false);
    // Category exists once a repo is assigned to it — just close the input
    // (user will drag or assign repos to this category via the card dropdown)
  };

  return (
    <motion.div
      className="flex-1 overflow-y-auto p-8"
      initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[#CAAA98]/40" />
          <div className="font-mono text-xs text-[#CAAA98] tracking-widest">ACTIVE_REPOSITORIES</div>
          <div className="font-mono text-[9px] text-[#9A8678]/40 tracking-wider">{projects.length} connected</div>
        </div>
        <div className="flex items-center gap-2">
          <motion.button
            onClick={() => setShowNewCategory(v => !v)}
            className="flex items-center gap-2 px-3 py-2 border border-[#CAAA98]/20 font-mono text-xs text-[#9A8678]/60 hover:text-[#CAAA98]/80 hover:border-[#CAAA98]/40 transition-all tracking-wider"
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
            title="Create a folder/category"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            NEW_FOLDER
          </motion.button>
          <motion.button
            onClick={onToggleAddRepo}
            className="flex items-center gap-2 px-4 py-2 border border-[#CAAA98]/30 font-mono text-xs text-[#9A8678] hover:text-[#CAAA98] hover:border-[#CAAA98]/60 transition-all tracking-wider"
            whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
          >
            <Plus className="w-3.5 h-3.5" />
            ADD_REPOSITORY
          </motion.button>
        </div>
      </div>

      {/* New category name input */}
      <AnimatePresence>
        {showNewCategory && (
          <motion.div
            className="mb-6 border border-[#CAAA98]/20 bg-[#0a0e1a]/60 p-4 flex gap-3 items-center"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
          >
            <div className="font-mono text-[10px] text-[#9A8678]/60 tracking-widest shrink-0">FOLDER_NAME</div>
            <input
              type="text"
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') handleCreateCategory(); if (e.key === 'Escape') setShowNewCategory(false); }}
              placeholder="e.g. BACKEND"
              autoFocus
              className="flex-1 bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2 px-3 focus:outline-none focus:border-[#CAAA98]/60 font-mono text-sm placeholder:text-[#9A8678]/25"
            />
            <button
              onClick={handleCreateCategory}
              className="px-4 py-2 border border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] font-mono text-xs tracking-widest hover:bg-[#CAAA98]/20 transition-all"
            >
              CREATE
            </button>
            <button onClick={() => setShowNewCategory(false)} className="p-2 text-[#9A8678]/40 hover:text-[#9A8678]">
              <X className="w-4 h-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add repo input form */}
      <AnimatePresence>
        {showAddRepo && (
          <motion.div
            className="mb-8 border border-[#CAAA98]/20 bg-[#0a0e1a]/60 p-6 backdrop-blur-sm"
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }}
          >
            <div className="font-mono text-[10px] text-[#9A8678]/70 tracking-widest mb-5">REPOSITORY_CONFIGURATION</div>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="font-mono text-[10px] text-[#9A8678]/60 tracking-wider mb-2 block">REPOSITORY_URL</label>
                <input
                  type="text"
                  value={newRepoUrl}
                  onChange={e => onNewRepoUrlChange(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && onAddRepo()}
                  placeholder="github.com/owner/repo  or  gitlab.com/owner/repo"
                  autoFocus
                  disabled={addingRepo}
                  className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm disabled:opacity-50"
                />
                {!anyPatSet && (
                  <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">
                    Set GitHub or GitLab PAT in settings to validate and enable healing
                  </div>
                )}
                {addRepoError && (
                  <div className="font-mono text-[9px] text-[#A06A6A] mt-1.5">{addRepoError}</div>
                )}
              </div>
              <motion.button
                onClick={() => onAddRepo()}
                disabled={addingRepo || !newRepoUrl.trim()}
                className="px-6 py-2.5 border border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] font-mono text-xs tracking-widest hover:bg-[#CAAA98]/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              >
                {addingRepo ? 'VALIDATING...' : '> CONNECT'}
              </motion.button>
              <button
                onClick={onToggleAddRepo}
                className="p-2.5 border border-[#9A8678]/20 text-[#9A8678]/40 hover:text-[#9A8678] hover:border-[#9A8678]/40 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Empty state */}
      {projects.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 gap-3">
          <div className="font-mono text-xs text-[#9A8678]/30 tracking-widest">NO_REPOSITORIES_CONNECTED</div>
          <div className="font-mono text-[10px] text-[#9A8678]/20">Click ADD_REPOSITORY to connect your first repo</div>
        </div>
      )}

      {/* Categories with their repo cards */}
      <div className="space-y-8">
        {categories.map(cat => {
          const isCollapsed = collapsedCategories.has(cat);
          const repos = grouped[cat];
          return (
            <div key={cat}>
              {/* Category header — clickable to collapse/expand */}
              <button
                onClick={() => toggleCategory(cat)}
                className="flex items-center gap-2 mb-4 w-full text-left group"
              >
                {isCollapsed
                  ? <ChevronRight className="w-3 h-3 text-[#9A8678]/40 group-hover:text-[#CAAA98]/60 transition-colors" />
                  : <ChevronDown  className="w-3 h-3 text-[#9A8678]/40 group-hover:text-[#CAAA98]/60 transition-colors" />
                }
                <div className="h-px w-4 bg-[#CAAA98]/20" />
                <span className="font-mono text-[10px] text-[#9A8678]/50 tracking-widest group-hover:text-[#CAAA98]/70 transition-colors">
                  {cat}
                </span>
                <span className="font-mono text-[9px] text-[#9A8678]/25 ml-1">({repos.length})</span>
                <div className="flex-1 h-px bg-[#CAAA98]/10" />
              </button>

              {/* Repo cards grid */}
              <AnimatePresence>
                {!isCollapsed && (
                  <motion.div
                    className="grid grid-cols-3 gap-4"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {repos.map((project, index) => (
                      <RepoCard
                        key={project.id}
                        project={project}
                        index={index}
                        allCategories={categories.filter(c => c !== 'UNCATEGORIZED')}
                        onSelect={() => onSelectProject(project.id)}
                        onRemove={() => onRemoveProject(project.id)}
                        onSetCategory={onSetCategory}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
