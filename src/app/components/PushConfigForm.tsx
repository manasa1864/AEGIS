import { motion } from 'motion/react';
import { GitBranch, Lock, Unlock, Upload, Check } from 'lucide-react';

type Mode = 'existing' | 'new';

interface PushConfigFormProps {
  githubPat: string;
  mode: Mode;
  repoInput: string;
  newRepoName: string;
  isPrivate: boolean;
  branch: string;
  commitMsg: string;
  pushing: boolean;
  canPush: boolean;
  pushComplete: boolean;
  repoUrl: string;
  onModeChange: (m: Mode) => void;
  onRepoInputChange: (v: string) => void;
  onNewRepoNameChange: (v: string) => void;
  onIsPrivateChange: (v: boolean) => void;
  onBranchChange: (v: string) => void;
  onCommitMsgChange: (v: string) => void;
  onPush: () => void;
}

export function PushConfigForm({
  githubPat, mode, repoInput, newRepoName, isPrivate, branch, commitMsg,
  pushing, canPush, pushComplete, repoUrl,
  onModeChange, onRepoInputChange, onNewRepoNameChange, onIsPrivateChange,
  onBranchChange, onCommitMsgChange, onPush,
}: PushConfigFormProps) {
  return (
    <>
      {/* Toggle: push to existing repo vs create a new one */}
      <div className="mb-6">
        <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-3">DESTINATION</div>
        <div className="flex gap-2">
          {(['existing', 'new'] as Mode[]).map(m => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`flex-1 py-2 border font-mono text-[10px] tracking-wider transition-all ${
                mode === m
                  ? 'border-[#CAAA98] text-[#CAAA98] bg-[#CAAA98]/10'
                  : 'border-[#9A8678]/20 text-[#9A8678]/50 hover:border-[#9A8678]/40'
              }`}
            >
              {m === 'existing' ? 'EXISTING_REPO' : 'CREATE_NEW_REPO'}
            </button>
          ))}
        </div>
      </div>

      {/* Repo-specific fields */}
      <div className="space-y-4 mb-6">
        {mode === 'existing' ? (
          <div>
            <label className="font-mono text-[10px] text-[#9A8678]/60 tracking-wider mb-2 block">REPOSITORY</label>
            <input
              type="text"
              value={repoInput}
              onChange={e => onRepoInputChange(e.target.value)}
              placeholder="owner/repo  or  github.com/owner/repo"
              className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="font-mono text-[10px] text-[#9A8678]/60 tracking-wider mb-2 block">REPOSITORY_NAME</label>
              <input
                type="text"
                value={newRepoName}
                onChange={e => onNewRepoNameChange(e.target.value)}
                placeholder="my-new-repo"
                className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
              />
            </div>
            <div className="flex gap-2">
              {[false, true].map(priv => (
                <button
                  key={String(priv)}
                  onClick={() => onIsPrivateChange(priv)}
                  className={`flex-1 py-2 border font-mono text-[10px] tracking-wider flex items-center justify-center gap-2 transition-all ${
                    isPrivate === priv
                      ? 'border-[#CAAA98] text-[#CAAA98] bg-[#CAAA98]/10'
                      : 'border-[#9A8678]/20 text-[#9A8678]/50 hover:border-[#9A8678]/40'
                  }`}
                >
                  {priv ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                  {priv ? 'PRIVATE' : 'PUBLIC'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Branch field — locked to "main" for new repos */}
        <div>
          <label className="font-mono text-[10px] text-[#9A8678]/60 tracking-wider mb-2 block">
            BRANCH
            {mode === 'new' && <span className="text-[#9A8678]/30 ml-2 normal-case tracking-normal">(new repos always push to main)</span>}
          </label>
          <div className="relative">
            <GitBranch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9A8678]/30" strokeWidth={1.5} />
            <input
              type="text"
              value={mode === 'new' ? 'main' : branch}
              onChange={e => mode === 'existing' && onBranchChange(e.target.value)}
              readOnly={mode === 'new'}
              placeholder="main"
              className={`w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 pl-10 pr-4 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm ${mode === 'new' ? 'opacity-40 cursor-not-allowed' : ''}`}
            />
          </div>
          {mode === 'existing' && (
            <div className="font-mono text-[9px] text-[#9A8678]/40 mt-1.5">created automatically if it doesn't exist</div>
          )}
        </div>

        {/* Optional commit message */}
        <div>
          <label className="font-mono text-[10px] text-[#9A8678]/60 tracking-wider mb-2 block">
            COMMIT_MESSAGE <span className="text-[#9A8678]/30">(optional)</span>
          </label>
          <input
            type="text"
            value={commitMsg}
            onChange={e => onCommitMsgChange(e.target.value)}
            placeholder="add: initial project files"
            className="w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-2.5 px-4 focus:outline-none focus:border-[#CAAA98]/60 transition-colors placeholder:text-[#9A8678]/25 font-mono text-sm"
          />
        </div>
      </div>

      {/* Warning when no GitHub PAT is set */}
      {!githubPat && (
        <div className="mb-4 font-mono text-[10px] text-[#D4A574]/70 border border-[#D4A574]/20 px-4 py-3">
          GITHUB_PAT not set — add it to .env or settings
        </div>
      )}

      {/* Main push button */}
      <motion.button
        onClick={onPush}
        disabled={!canPush}
        className="w-full py-4 border-2 border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] font-mono text-sm tracking-widest hover:bg-[#CAAA98]/20 transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-3 relative overflow-hidden"
        whileHover={canPush ? { scale: 1.01 } : {}}
        whileTap={canPush ? { scale: 0.99 } : {}}
      >
        {!pushing && canPush && (
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-[#CAAA98]/10 to-transparent"
            animate={{ x: ['-100%', '200%'] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          />
        )}
        <Upload className="w-4 h-4 relative z-10" strokeWidth={1.5} />
        <span className="relative z-10">{pushing ? '[ PUSHING... ]' : '[ PUSH TO GITHUB ]'}</span>
      </motion.button>

      {/* Success link shown after a successful push */}
      {pushComplete && repoUrl && (
        <motion.a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 border border-[#6A9A7A]/30 bg-[#6A9A7A]/5 p-4 flex items-center gap-3 hover:bg-[#6A9A7A]/10 transition-colors"
        >
          <Check className="w-4 h-4 text-[#6A9A7A] flex-shrink-0" strokeWidth={1.5} />
          <div className="font-mono text-[10px] text-[#6A9A7A]">
            view on github → {repoUrl.replace('https://', '')}
          </div>
        </motion.a>
      )}
    </>
  );
}
