import { motion, AnimatePresence } from 'motion/react';
import { Terminal } from 'lucide-react';

interface TerminalPanelProps {
  logs: string[];
  showLogs: boolean;
  onToggle: () => void;
}

export function TerminalPanel({ logs, showLogs, onToggle }: TerminalPanelProps) {
  return (
    <>
      {/* The sliding terminal drawer */}
      <AnimatePresence>
        {showLogs && (
          <motion.div
            className="relative z-20 bg-[#0a0e1a]/95 border-t border-[#CAAA98]/20 flex-shrink-0"
            initial={{ height: 0, opacity: 0 }} animate={{ height: '240px', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }}
          >
            <div className="px-4 py-2 border-b border-[#CAAA98]/20 flex items-center justify-between bg-[#0a0e1a]">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#CAAA98]" strokeWidth={1.5} />
                <div className="font-mono text-xs text-[#CAAA98] tracking-widest">SYSTEM_TERMINAL</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#6A9A7A]" />
                <div className="w-2 h-2 rounded-full bg-[#D4A574]" />
                <div className="w-2 h-2 rounded-full bg-[#A06A6A]" />
              </div>
            </div>
            <div className="p-4 h-[200px] overflow-y-auto font-mono text-[11px] leading-relaxed">
              {logs.map((log, i) => (
                <motion.div
                  key={i}
                  className="text-[#CAAA98]/80 hover:text-[#CAAA98] transition-colors py-0.5"
                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.02 }}
                >
                  <span className="text-[#9A8678]">&gt;</span> {log}
                </motion.div>
              ))}
              {logs.length === 0 && (
                <div className="text-[#9A8678]/40 text-center py-12 font-mono text-xs tracking-wider">[ NO_LOGS_AVAILABLE ]</div>
              )}
              {logs.length > 0 && (
                <motion.div className="inline-block w-2 h-4 bg-[#CAAA98] ml-1" animate={{ opacity: [0, 1, 0] }} transition={{ duration: 1, repeat: Infinity }} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating toggle button */}
      <motion.button
        onClick={onToggle}
        className="absolute bottom-6 right-6 z-30 px-4 py-2 border border-[#CAAA98]/30 bg-[#0a0e1a]/90 hover:border-[#CAAA98] hover:bg-[#0a0e1a] transition-all font-mono text-xs text-[#CAAA98] tracking-wider flex items-center gap-2"
        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
      >
        <Terminal className="w-3.5 h-3.5" strokeWidth={1.5} />
        {showLogs ? '[ HIDE_TERMINAL ]' : '[ SHOW_TERMINAL ]'}
      </motion.button>
    </>
  );
}
