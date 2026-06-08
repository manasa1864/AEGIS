import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { GitBranch, X, Star, GitFork, Folder, ChevronDown } from 'lucide-react';
import { Project } from '../types';

interface RepoCardProps {
  project: Project;
  index: number;
  allCategories: string[];
  onSelect: () => void;
  onRemove: () => void;
  onSetCategory: (id: string, category: string) => void;
}

// Maps healingStatus → display label + color classes
function healingBadge(p: Project): { label: string; classes: string } {
  if (p.healingStatus === 'NO_ERROR') return { label: 'NO ERROR', classes: 'border-[#6A9A7A] text-[#6A9A7A]' };
  if (p.healingStatus === 'LOW')      return { label: 'LOW',      classes: 'border-[#8AB87A] text-[#8AB87A]' };
  if (p.healingStatus === 'MEDIUM')   return { label: 'MEDIUM',   classes: 'border-[#D4A574] text-[#D4A574]' };
  if (p.healingStatus === 'HIGH')     return { label: 'HIGH',     classes: 'border-[#A06A6A] text-[#A06A6A]' };

  // Not yet scanned — show neutral scanning state
  if (p.errorType === 'PENDING_SCAN') return { label: 'SCANNING', classes: 'border-[#9A8678]/40 text-[#9A8678]/40' };

  // CI scan complete but no healing run yet
  if (p.errorType === 'CI_HEALTHY') return { label: 'NO ERROR', classes: 'border-[#6A9A7A] text-[#6A9A7A]' };
  if (p.errorType?.startsWith('FAILING:')) return { label: 'FAILING', classes: 'border-[#A06A6A] text-[#A06A6A]' };

  // Legacy fallback
  if (p.severity === 'low')    return { label: 'NO ERROR', classes: 'border-[#6A9A7A] text-[#6A9A7A]' };
  if (p.severity === 'medium') return { label: 'MEDIUM',   classes: 'border-[#D4A574] text-[#D4A574]' };
  return                              { label: 'HIGH',     classes: 'border-[#A06A6A] text-[#A06A6A]' };
}

export function RepoCard({ project, index, allCategories, onSelect, onRemove, onSetCategory }: RepoCardProps) {
  const [showCategoryMenu, setShowCategoryMenu] = useState(false);
  const [customCategory, setCustomCategory]     = useState('');

  const isConnected = !!(project.owner && project.repoName);
  const badge       = healingBadge(project);
  const currentCat  = project.category?.trim() || '';

  const assignCategory = (cat: string) => {
    onSetCategory(project.id, cat);
    setShowCategoryMenu(false);
    setCustomCategory('');
  };

  return (
    <motion.div
      className="group relative"
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.07 }}
    >
      <motion.button
        onClick={onSelect}
        className="w-full border border-[#CAAA98]/15 bg-[#0a0e1a]/50 p-6 text-left hover:border-[#CAAA98]/45 hover:bg-[#0a0e1a]/70 transition-all backdrop-blur-sm"
        whileHover={{ scale: 1.02, y: -2 }} whileTap={{ scale: 0.98 }}
      >
        {/* Top row: platform indicator + healing badge */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[#9A8678]/40 group-hover:text-[#CAAA98]/60 transition-colors" strokeWidth={1.5} />
            {isConnected && <div className="w-1.5 h-1.5 rounded-full bg-[#6A9A7A]/60" title={`${project.platform ?? 'github'} connected`} />}
            {project.platform === 'gitlab' && (
              <div className="font-mono text-[8px] text-[#9A8678]/40 tracking-wider border border-[#9A8678]/20 px-1.5 py-0.5">GL</div>
            )}
          </div>
          <div className={`px-2 py-0.5 border font-mono text-[9px] tracking-wider ${badge.classes}`}>
            {badge.label}
          </div>
        </div>

        {/* Repo name + description */}
        <div className="font-mono text-sm text-[#CAAA98] mb-1">{project.name}</div>
        {project.description && (
          <div className="font-mono text-[9px] text-[#9A8678]/40 mb-2 line-clamp-1">{project.description}</div>
        )}
        <div className={`font-mono text-xs mb-4 ${project.errorType === 'CI_HEALTHY' ? 'text-[#6A9A7A]/70' : project.errorType === 'PENDING_SCAN' ? 'text-[#9A8678]/40' : 'text-[#A06A6A]/70'}`}>
          {project.errorType === 'CI_HEALTHY'   ? 'STATUS :: CI_HEALTHY' :
           project.errorType === 'PENDING_SCAN' ? 'STATUS :: SCANNING...' :
           `ERROR :: ${project.errorType}`}
        </div>

        {/* Bottom meta row */}
        <div className="pt-3 border-t border-[#CAAA98]/10 space-y-1.5">
          <div className="font-mono text-[10px] text-[#9A8678]/40">
            branch: <span className="text-[#9A8678]/70">{project.repo}</span>
            {project.language && (
              <span className="ml-3 text-[#9A8678]/40">
                lang: <span className="text-[#9A8678]/60">{project.language}</span>
              </span>
            )}
          </div>
          {(project.stars !== undefined || project.forks !== undefined) && (
            <div className="flex items-center gap-4">
              {project.stars !== undefined && (
                <div className="flex items-center gap-1 font-mono text-[9px] text-[#9A8678]/40">
                  <Star className="w-2.5 h-2.5" strokeWidth={1.5} />
                  {project.stars.toLocaleString()}
                </div>
              )}
              {project.forks !== undefined && (
                <div className="flex items-center gap-1 font-mono text-[9px] text-[#9A8678]/40">
                  <GitFork className="w-2.5 h-2.5" strokeWidth={1.5} />
                  {project.forks.toLocaleString()}
                </div>
              )}
              {project.openIssues !== undefined && (
                <div className="font-mono text-[9px] text-[#9A8678]/40">{project.openIssues} open issues</div>
              )}
            </div>
          )}
        </div>
      </motion.button>

      {/* Remove button — top-right, visible on hover */}
      <button
        onClick={e => { e.stopPropagation(); onRemove(); }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 text-[#9A8678]/30 hover:text-[#A06A6A] transition-all"
      >
        <X className="w-3 h-3" />
      </button>

      {/* Category pill — bottom-left, visible on hover */}
      <div className="absolute bottom-3 left-3 opacity-0 group-hover:opacity-100 transition-all">
        <div className="relative">
          <button
            onClick={e => { e.stopPropagation(); setShowCategoryMenu(v => !v); }}
            className="flex items-center gap-1 px-2 py-0.5 border border-[#CAAA98]/20 bg-[#0a0e1a]/80 font-mono text-[8px] text-[#9A8678]/50 hover:text-[#CAAA98]/70 hover:border-[#CAAA98]/40 transition-all tracking-wider"
          >
            <Folder className="w-2.5 h-2.5" />
            {currentCat || 'SET_FOLDER'}
            <ChevronDown className="w-2.5 h-2.5" />
          </button>

          <AnimatePresence>
            {showCategoryMenu && (
              <motion.div
                className="absolute bottom-7 left-0 z-50 min-w-[160px] border border-[#CAAA98]/20 bg-[#0a0e1a]/95 backdrop-blur-sm py-1"
                initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
                onClick={e => e.stopPropagation()}
              >
                {/* Existing categories */}
                {allCategories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => assignCategory(cat)}
                    className={`w-full text-left px-3 py-1.5 font-mono text-[9px] tracking-wider hover:bg-[#CAAA98]/10 transition-colors ${
                      currentCat === cat ? 'text-[#CAAA98]' : 'text-[#9A8678]/60'
                    }`}
                  >
                    {cat}
                  </button>
                ))}

                {/* Divider + new category input */}
                {allCategories.length > 0 && <div className="h-px bg-[#CAAA98]/10 my-1" />}
                <div className="px-2 py-1.5 flex gap-1">
                  <input
                    type="text"
                    value={customCategory}
                    onChange={e => setCustomCategory(e.target.value.toUpperCase())}
                    onKeyDown={e => { if (e.key === 'Enter' && customCategory.trim()) assignCategory(customCategory.trim()); }}
                    placeholder="NEW FOLDER"
                    className="flex-1 bg-[#202940]/60 border border-[#9A8678]/20 text-[#CAAA98] px-2 py-1 font-mono text-[9px] focus:outline-none focus:border-[#CAAA98]/40 placeholder:text-[#9A8678]/25"
                  />
                  <button
                    onClick={() => customCategory.trim() && assignCategory(customCategory.trim())}
                    className="px-2 text-[#CAAA98]/60 hover:text-[#CAAA98] font-mono text-[9px] border border-[#CAAA98]/20 hover:border-[#CAAA98]/40 transition-colors"
                  >
                    +
                  </button>
                </div>

                {/* Remove from category */}
                {currentCat && (
                  <>
                    <div className="h-px bg-[#CAAA98]/10 my-1" />
                    <button
                      onClick={() => assignCategory('')}
                      className="w-full text-left px-3 py-1.5 font-mono text-[9px] tracking-wider text-[#A06A6A]/60 hover:text-[#A06A6A] hover:bg-[#A06A6A]/5 transition-colors"
                    >
                      REMOVE FROM FOLDER
                    </button>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
