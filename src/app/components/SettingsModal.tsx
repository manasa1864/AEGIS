import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Eye, EyeOff, Zap } from 'lucide-react';

export interface AegisSettings {
  githubPat: string;
  gitlabPat: string;
  /** Self-hosted GitLab host ("gitlab.example.com"); empty = gitlab.com */
  gitlabHost: string;
  groqKey: string;
  geminiKey: string;
  /** Google Cloud / AI Studio key used for search-grounded analysis */
  gcloudKey: string;
  /** Start healing automatically when a watched repo's CI turns red */
  autoHeal: boolean;
}

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  current: AegisSettings;
  onSave: (settings: AegisSettings) => void;
}

const INPUT = 'w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 pr-10 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm';

function SecretField({ label, badge, hint, value, placeholder, onChange, secret = true }: {
  label: string; badge?: string; hint: string; value: string; placeholder: string; onChange: (v: string) => void; secret?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="font-mono text-[10px] text-[#9A8678] tracking-wider mb-2 block">
        {label} {badge && <span className="text-[#6A9A7A]/50 normal-case tracking-normal">({badge})</span>}
      </label>
      <div className="relative">
        <input type={secret && !show ? 'password' : 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={INPUT} />
        {secret && (
          <button onClick={() => setShow(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8678]/40 hover:text-[#9A8678]" type="button">
            {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        )}
      </div>
      <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">{hint}</div>
    </div>
  );
}

export function SettingsModal({ show, onClose, current, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState<AegisSettings>(current);
  const set = <K extends keyof AegisSettings>(key: K) => (value: AegisSettings[K]) => setDraft(d => ({ ...d, [key]: value }));

  const handleSave = () => {
    onSave({ ...draft, gitlabHost: draft.gitlabHost.trim() });
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
            className="w-[680px] max-w-[95vw] max-h-[92vh] overflow-y-auto custom-scrollbar border border-[#CAAA98]/30 bg-[#0a0e1a] p-8"
            initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex items-center justify-between mb-8">
              <div className="font-mono text-sm text-[#CAAA98] tracking-widest">ACCESS_CONFIGURATION</div>
              <button onClick={onClose} className="text-[#9A8678]/40 hover:text-[#9A8678] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Repository access */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <SecretField label="GITHUB_PAT" hint="repo + workflow scopes (workflow is needed for the auto-fixer job)" value={draft.githubPat} placeholder="ghp_xxxxxxxxxxxx" onChange={set('githubPat')} />
              <SecretField label="GITLAB_PAT" hint="api + read_api + write_repository scopes" value={draft.gitlabPat} placeholder="glpat-xxxxxxxxxxxx" onChange={set('gitlabPat')} />
            </div>
            <div className="mb-5">
              <SecretField
                label="GITLAB_HOST" badge="optional · self-hosted" secret={false}
                hint="leave empty for gitlab.com — a self-hosted instance must allow CORS from this dashboard's origin"
                value={draft.gitlabHost} placeholder="gitlab.example.com" onChange={set('gitlabHost')}
              />
            </div>

            <div className="border-t border-[#CAAA98]/10 mb-5" />

            {/* AI providers — last resort in the healing ladder */}
            <div className="font-mono text-[9px] text-[#9A8678]/50 mb-3">
              AI is only used after known fixes, rules, the flaky check and the repo's own auto-fixers have been tried.
            </div>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <SecretField label="GROQ_KEY" badge="free · llama-3.3-70b" hint="console.groq.com — no credit card" value={draft.groqKey} placeholder="gsk_xxxxxxxxxxxxxxxxxxxx" onChange={set('groqKey')} />
              <SecretField label="GEMINI_KEY" badge="free tier" hint="aistudio.google.com/apikey — no credit card" value={draft.geminiKey} placeholder="AIzaxxxxxxxxxxxxxxxxx" onChange={set('geminiKey')} />
            </div>
            <div className="mb-6">
              <SecretField
                label="GCLOUD_KEY" badge="optional · search-grounded analysis"
                hint="a Gemini API key with Google Search grounding — the model looks up docs and known issues for the exact error"
                value={draft.gcloudKey} placeholder="AIzaxxxxxxxxxxxxxxxxx" onChange={set('gcloudKey')}
              />
            </div>

            <div className="border-t border-[#CAAA98]/10 mb-5" />

            {/* Auto-heal */}
            <button
              type="button"
              onClick={() => set('autoHeal')(!draft.autoHeal)}
              className="w-full flex items-start gap-3 text-left mb-8 p-3 border transition-colors"
              style={{ borderColor: draft.autoHeal ? '#D4A57480' : '#9A867830', backgroundColor: draft.autoHeal ? 'rgba(212,165,116,0.06)' : 'transparent' }}
            >
              <div className="mt-0.5 w-8 h-4 rounded-full relative flex-shrink-0 transition-colors" style={{ backgroundColor: draft.autoHeal ? '#D4A574' : '#9A867840' }}>
                <div className="absolute top-0.5 w-3 h-3 rounded-full bg-[#0a0e1a] transition-all" style={{ left: draft.autoHeal ? '18px' : '2px' }} />
              </div>
              <div>
                <div className="font-mono text-[10px] tracking-wider flex items-center gap-1.5" style={{ color: draft.autoHeal ? '#D4A574' : '#9A8678' }}>
                  <Zap className="w-3 h-3" /> AUTO_HEAL
                </div>
                <div className="font-mono text-[9px] text-[#9A8678]/60 mt-1 leading-relaxed">
                  While this dashboard is open, start healing automatically when a watched repository's CI turns red
                  (checked every 30s). Safe mode still applies. Fixes always arrive as a PR — nothing is pushed to your default branch.
                </div>
              </div>
            </button>

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
            <div className="mt-6 pt-5 border-t border-[#CAAA98]/10 grid grid-cols-6 gap-3">
              {[
                { label: 'GITHUB', active: !!draft.githubPat },
                { label: 'GITLAB', active: !!draft.gitlabPat },
                { label: 'GROQ', active: !!draft.groqKey },
                { label: 'GEMINI', active: !!draft.geminiKey },
                { label: 'GCLOUD', active: !!draft.gcloudKey },
                { label: 'AUTO', active: draft.autoHeal },
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
