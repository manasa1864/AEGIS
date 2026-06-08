import { motion } from 'motion/react';
import { Network, Settings, LogOut } from 'lucide-react';
import { SystemStatus, View } from '../types';

interface TopBarProps {
  systemStatus: SystemStatus;
  view: View;
  onViewChange: (v: View) => void;
  anyPatSet: boolean;
  onOpenSettings: () => void;
  onLogout: () => void;
}

const TABS: { id: View; label: string }[] = [
  { id: 'healing',      label: 'HEALING' },
  { id: 'history',      label: 'HISTORY' },
  { id: 'intelligence', label: 'INTELLIGENCE' },
];

export function TopBar({ systemStatus, view, onViewChange, anyPatSet, onOpenSettings, onLogout }: TopBarProps) {
  const statusColor = systemStatus === 'healing' ? '#D4A574'
    : systemStatus === 'stopped' ? '#A06A6A'
    : systemStatus === 'healthy' ? '#6A9A7A'
    : '#CAAA98';

  return (
    <div className="relative z-10 border-b border-[#CAAA98]/20 bg-[#0a0e1a]/70 backdrop-blur-sm flex-shrink-0">
      <div className="flex items-center justify-between px-6 py-4">

        {/* AEGIS logo — spins while healing */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <motion.div className="relative w-9 h-9"
            animate={{ rotate: systemStatus === 'healing' ? 360 : 0 }}
            transition={{ duration: 8, repeat: systemStatus === 'healing' ? Infinity : 0, ease: 'linear' }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <polygon points="50,5 90,25 90,75 50,95 10,75 10,25" fill="none" stroke="#CAAA98" strokeWidth="2" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <Network className="w-4 h-4 text-[#CAAA98]" strokeWidth={1.5} />
            </div>
          </motion.div>
          <div>
            <div className="font-mono text-base tracking-[0.2em] text-[#CAAA98]">AEGIS</div>
            <div className="font-mono text-[8px] text-[#9A8678]/50 tracking-widest">NEURAL_AUTONOMOUS_SYSTEM</div>
          </div>
        </div>

        {/* Page switcher tabs */}
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => onViewChange(tab.id)}
              className={`font-mono text-[9px] tracking-widest px-3 py-1.5 border transition-all whitespace-nowrap flex-shrink-0 ${
                view === tab.id
                  ? 'border-[#CAAA98]/50 text-[#CAAA98] bg-[#CAAA98]/10'
                  : 'border-transparent text-[#9A8678]/40 hover:text-[#9A8678]/70'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* System status badge + settings + logout */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <motion.div
            className="px-3 py-1.5 border font-mono text-[10px] tracking-widest flex items-center gap-2"
            style={{ borderColor: statusColor, color: statusColor }}
            animate={{ boxShadow: systemStatus === 'healing' ? ['0 0 10px rgba(212,165,116,0.3)', '0 0 20px rgba(212,165,116,0.6)', '0 0 10px rgba(212,165,116,0.3)'] : 'none' }}
            transition={{ duration: 2, repeat: systemStatus === 'healing' ? Infinity : 0 }}
          >
            <motion.div className="w-1.5 h-1.5" style={{ backgroundColor: statusColor }}
              animate={{ opacity: systemStatus === 'healing' ? [0.5, 1, 0.5] : 1 }}
              transition={{ duration: 1, repeat: systemStatus === 'healing' ? Infinity : 0 }}
            />
            {systemStatus === 'healing' && '[ HEALING ]'}
            {systemStatus === 'stopped' && '[ HALTED ]'}
            {systemStatus === 'healthy' && '[ HEALTHY ]'}
            {systemStatus === 'idle'    && '[ STANDBY ]'}
          </motion.div>

          <button onClick={onOpenSettings}
            className="relative p-2 border border-[#9A8678]/30 hover:border-[#CAAA98]/50 transition-colors group"
            title="ACCESS_CONFIGURATION"
          >
            <Settings className="w-4 h-4 text-[#9A8678] group-hover:text-[#CAAA98] transition-colors" strokeWidth={1.5} />
            {anyPatSet && <div className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-[#6A9A7A]" />}
          </button>

          <button onClick={onLogout}
            className="p-2 border border-[#9A8678]/30 hover:border-[#A06A6A]/70 hover:bg-[#A06A6A]/10 transition-colors group"
            title="TERMINATE_SESSION"
          >
            <LogOut className="w-4 h-4 text-[#9A8678] group-hover:text-[#A06A6A] transition-colors" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}
