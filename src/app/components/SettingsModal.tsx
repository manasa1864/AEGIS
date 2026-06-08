import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Eye, EyeOff } from 'lucide-react';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  currentPat: string;
  currentGitlabPat: string;
  currentGeminiKey: string;
  currentGroqKey: string;
  onSave: (pat: string, gitlabPat: string, geminiKey: string, groqKey: string) => void;
}

export function SettingsModal({
  show, onClose, currentPat, currentGitlabPat, currentGeminiKey, currentGroqKey, onSave,
}: SettingsModalProps) {
  const [draftPat, setDraftPat] = useState(currentPat);
  const [draftGitlabPat, setDraftGitlabPat] = useState(currentGitlabPat);
  const [draftGeminiKey, setDraftGeminiKey] = useState(currentGeminiKey);
  const [draftGroqKey, setDraftGroqKey] = useState(currentGroqKey);
  const [showPat, setShowPat] = useState(false);
  const [showGitlabPat, setShowGitlabPat] = useState(false);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showGroqKey, setShowGroqKey] = useState(false);

  const handleSave = () => {
    onSave(draftPat, draftGitlabPat, draftGeminiKey, draftGroqKey);
    onClose();
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
          <motion.div
            className="w-[640px] border border-[#CAAA98]/30 bg-[#0a0e1a] p-8"
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-between mb-8">
              <div className="font-mono text-sm text-[#CAAA98] tracking-widest">ACCESS_CONFIGURATION</div>
              <button onClick={onClose} className="text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* GitHub PAT + GitLab PAT side by side */}
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div>
                <label className="font-mono text-[10px] text-[#9A8678] tracking-wider mb-2 block">GITHUB_PAT</label>
                <div className="relative">
                  <input
                    type={showPat ? 'text' : 'password'}
                    value={draftPat}
                    onChange={e => setDraftPat(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxx"
                    className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 pr-10 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
                  />
                  <button onClick={() => setShowPat(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8678]/40 hover:text-[#9A8678]">
                    {showPat ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">repo + workflow scopes</div>
              </div>

              <div>
                <label className="font-mono text-[10px] text-[#9A8678] tracking-wider mb-2 block">GITLAB_PAT</label>
                <div className="relative">
                  <input
                    type={showGitlabPat ? 'text' : 'password'}
                    value={draftGitlabPat}
                    onChange={e => setDraftGitlabPat(e.target.value)}
                    placeholder="glpat-xxxxxxxxxxxx"
                    className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 pr-10 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
                  />
                  <button onClick={() => setShowGitlabPat(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8678]/40 hover:text-[#9A8678]">
                    {showGitlabPat ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">api + read_api + write_repository scopes</div>
              </div>
            </div>

            <div className="border-t border-[#CAAA98]/10 mb-5" />

            {/* Groq + Gemini side by side */}
            <div className="grid grid-cols-2 gap-4 mb-8">
              <div>
                <label className="font-mono text-[10px] text-[#9A8678] tracking-wider mb-2 block">
                  GROQ_KEY <span className="text-[#6A9A7A]/50 normal-case tracking-normal">(free · llama-3.3-70b)</span>
                </label>
                <div className="relative">
                  <input
                    type={showGroqKey ? 'text' : 'password'}
                    value={draftGroqKey}
                    onChange={e => setDraftGroqKey(e.target.value)}
                    placeholder="gsk_xxxxxxxxxxxxxxxxxxxx"
                    className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 pr-10 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
                  />
                  <button onClick={() => setShowGroqKey(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8678]/40 hover:text-[#9A8678]">
                    {showGroqKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">console.groq.com — no credit card</div>
              </div>

              <div>
                <label className="font-mono text-[10px] text-[#9A8678] tracking-wider mb-2 block">
                  GEMINI_KEY <span className="text-[#6A9A7A]/50 normal-case tracking-normal">(free tier)</span>
                </label>
                <div className="relative">
                  <input
                    type={showGeminiKey ? 'text' : 'password'}
                    value={draftGeminiKey}
                    onChange={e => setDraftGeminiKey(e.target.value)}
                    placeholder="AIzaxxxxxxxxxxxxxxxxx"
                    className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 pr-10 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
                  />
                  <button onClick={() => setShowGeminiKey(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8678]/40 hover:text-[#9A8678]">
                    {showGeminiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">aistudio.google.com/apikey — no credit card</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <motion.button
                onClick={handleSave}
                className="flex-1 py-3 border border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] font-mono text-xs tracking-widest hover:bg-[#CAAA98]/20 transition-all"
                whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.99 }}
              >
                SAVE_CONFIGURATION
              </motion.button>
              <button
                onClick={onClose}
                className="px-6 py-3 border border-[#9A8678]/20 text-[#9A8678]/60 font-mono text-xs tracking-widest hover:border-[#9A8678]/40 hover:text-[#9A8678] transition-all"
              >
                CANCEL
              </button>
            </div>

            {/* Connected status indicators */}
            <div className="mt-6 pt-5 border-t border-[#CAAA98]/10 grid grid-cols-4 gap-3">
              {[
                { label: 'GITHUB', active: !!draftPat },
                { label: 'GITLAB', active: !!draftGitlabPat },
                { label: 'GROQ', active: !!draftGroqKey },
                { label: 'GEMINI', active: !!draftGeminiKey },
              ].map(({ label, active }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${active ? 'bg-[#6A9A7A]' : 'bg-[#9A8678]/30'}`} />
                  <div className="font-mono text-[9px] text-[#9A8678]/60 tracking-wider">{label}</div>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
