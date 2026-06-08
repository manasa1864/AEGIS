import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, AlertCircle, CheckCircle, XCircle, Loader2, Terminal } from 'lucide-react';

export interface StreamEntry {
  id: string;
  type: 'detected' | 'attempt' | 'result' | 'decision' | 'info';
  message: string;
  status?: 'success' | 'failure' | 'pending';
  timestamp?: string;
  url?: string;
}

interface IntelligenceStreamProps {
  entries: StreamEntry[];
}

export function IntelligenceStream({ entries }: IntelligenceStreamProps) {
  const getIcon = (entry: StreamEntry) => {
    if (entry.type === 'decision') {
      return <ChevronRight className="w-4 h-4 text-[#CAAA98]" strokeWidth={1.5} />;
    }
    if (entry.type === 'detected') {
      return <AlertCircle className="w-4 h-4 text-[#D4A574]" strokeWidth={1.5} />;
    }
    if (entry.type === 'result') {
      if (entry.status === 'success') {
        return <CheckCircle className="w-4 h-4 text-[#6A9A7A]" strokeWidth={1.5} />;
      }
      if (entry.status === 'failure') {
        return <XCircle className="w-4 h-4 text-[#A06A6A]" strokeWidth={1.5} />;
      }
      return <Loader2 className="w-4 h-4 text-[#9A8678] animate-spin" strokeWidth={1.5} />;
    }
    return <Terminal className="w-4 h-4 text-[#9A8678]" strokeWidth={1.5} />;
  };

  const getTextColor = (entry: StreamEntry) => {
    if (entry.type === 'decision') return 'text-[#CAAA98]';
    if (entry.type === 'detected') return 'text-[#D4A574]';
    if (entry.type === 'result' && entry.status === 'success') return 'text-[#6A9A7A]';
    if (entry.type === 'result' && entry.status === 'failure') return 'text-[#A06A6A]';
    return 'text-[#9A8678]';
  };

  const getPrefix = (entry: StreamEntry) => {
    if (entry.type === 'detected') return 'DETECT';
    if (entry.type === 'attempt') return 'ATTEMPT';
    if (entry.type === 'result') return 'RESULT';
    if (entry.type === 'decision') return 'DECISION';
    return 'INFO';
  };

  return (
    <div className="h-full flex flex-col bg-[#0a0e1a]/40 border-l border-[#CAAA98]/10">
      {/* Header */}
      <div className="border-b border-[#CAAA98]/20 p-4 bg-[#0a0e1a]/60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <motion.div
              className="w-2 h-2 bg-[#CAAA98]"
              animate={{
                opacity: [0.3, 1, 0.3],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
              }}
            />
            <div className="font-mono text-xs text-[#CAAA98] tracking-widest">NEURAL_STREAM</div>
          </div>
          <div className="font-mono text-[9px] text-[#9A8678]/60">{entries.length} EVENTS</div>
        </div>
      </div>

      {/* Stream Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {entries.map((entry, index) => (
              <motion.div
                key={entry.id}
                className="border border-[#9A8678]/20 bg-[#0a0e1a]/60 p-3"
                initial={{ opacity: 0, x: -20, height: 0 }}
                animate={{ opacity: 1, x: 0, height: 'auto' }}
                exit={{ opacity: 0, x: 20, height: 0 }}
                transition={{ delay: index * 0.05 }}
              >
                <div className="flex items-start gap-2 mb-1.5">
                  <div className="flex-shrink-0 mt-0.5">
                    {getIcon(entry)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`font-mono text-[9px] tracking-widest ${getTextColor(entry)}`}>
                        [{getPrefix(entry)}]
                      </div>
                      <div className="font-mono text-[8px] text-[#9A8678]/60">
                        {entry.timestamp || new Date().toLocaleTimeString()}
                      </div>
                    </div>
                    <div className={`font-mono text-[11px] leading-relaxed ${getTextColor(entry)}`}>
                      {entry.message}
                    </div>
                    {entry.url && (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[10px] text-[#CAAA98]/60 hover:text-[#CAAA98] underline underline-offset-2 mt-1 block truncate"
                      >
                        → {entry.url}
                      </a>
                    )}
                  </div>
                </div>

                {/* Status bar */}
                <div className="flex items-center gap-1 mt-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <motion.div
                      key={i}
                      className="h-0.5 flex-1"
                      style={{
                        backgroundColor: entry.status === 'success'
                          ? '#6A9A7A'
                          : entry.status === 'failure'
                          ? '#A06A6A'
                          : '#9A8678',
                        opacity: 0.3,
                      }}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={{ delay: index * 0.05 + i * 0.02 }}
                    />
                  ))}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {entries.length === 0 && (
            <div className="text-center py-16">
              <motion.div
                className="inline-block"
                animate={{
                  opacity: [0.3, 0.6, 0.3],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                }}
              >
                <Terminal className="w-10 h-10 text-[#9A8678]/40 mx-auto mb-3" strokeWidth={1} />
                <div className="font-mono text-xs text-[#9A8678]/60 tracking-wider">
                  [ STANDBY ]
                </div>
                <div className="font-mono text-[10px] text-[#9A8678]/40 mt-1">
                  AWAITING_EVENTS...
                </div>
              </motion.div>
            </div>
          )}
        </div>
      </div>

      {/* Footer Stats */}
      <div className="border-t border-[#CAAA98]/20 p-3 bg-[#0a0e1a]/60">
        <div className="grid grid-cols-3 gap-3 font-mono text-[9px]">
          <div className="text-center">
            <div className="text-[#9A8678]/60 mb-1">SUCCESS</div>
            <div className="text-[#6A9A7A]">
              {entries.filter(e => e.status === 'success').length}
            </div>
          </div>
          <div className="text-center border-x border-[#9A8678]/20">
            <div className="text-[#9A8678]/60 mb-1">FAILED</div>
            <div className="text-[#A06A6A]">
              {entries.filter(e => e.status === 'failure').length}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[#9A8678]/60 mb-1">PENDING</div>
            <div className="text-[#D4A574]">
              {entries.filter(e => !e.status || e.status === 'pending').length}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
