import { motion } from 'motion/react';
import { PushLogEntry } from '../types';

interface PushLogStreamProps {
  logs: PushLogEntry[];
  pushing: boolean;
}

export function PushLogStream({ logs, pushing }: PushLogStreamProps) {
  if (logs.length === 0) return null;

  return (
    <motion.div
      className="w-[360px] border-l border-[#CAAA98]/10 flex-shrink-0 overflow-y-auto p-6"
      initial={{ x: 360, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
    >
      <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-4">PUSH_LOG</div>
      <div className="space-y-2">
        {logs.map(log => (
          <motion.div
            key={log.id}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-start gap-2"
          >
            {/* Colored dot: green = success, red = error, grey = info */}
            <div className={`w-1 h-1 rounded-full mt-1.5 flex-shrink-0 ${
              log.type === 'success' ? 'bg-[#6A9A7A]'
              : log.type === 'error' ? 'bg-[#A06A6A]'
              : 'bg-[#9A8678]/40'
            }`} />
            <div className={`font-mono text-[10px] leading-relaxed break-all ${
              log.type === 'success' ? 'text-[#6A9A7A]'
              : log.type === 'error' ? 'text-[#A06A6A]'
              : 'text-[#9A8678]/70'
            }`}>
              {log.message}
            </div>
          </motion.div>
        ))}

        {/* Blinking cursor while push is in progress */}
        {pushing && (
          <motion.div
            className="inline-block w-2 h-4 bg-[#CAAA98] ml-3"
            animate={{ opacity: [0, 1, 0] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
        )}
      </div>
    </motion.div>
  );
}
