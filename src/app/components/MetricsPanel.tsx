import { motion } from 'motion/react';
import { useEffect, useState } from 'react';

interface MetricsPanelProps {
  systemStatus: 'idle' | 'healing' | 'stopped' | 'healthy';
}

export function MetricsPanel({ systemStatus }: MetricsPanelProps) {
  const [cpuUsage, setCpuUsage] = useState(23);
  const [memoryUsage, setMemoryUsage] = useState(42);
  const [networkLatency, setNetworkLatency] = useState(12);
  const [activeThreads, setActiveThreads] = useState(8);

  useEffect(() => {
    if (systemStatus === 'healing') {
      const interval = setInterval(() => {
        setCpuUsage(prev => Math.min(95, prev + Math.random() * 10));
        setMemoryUsage(prev => Math.min(85, prev + Math.random() * 5));
        setNetworkLatency(prev => Math.max(5, Math.min(50, prev + (Math.random() - 0.5) * 10)));
        setActiveThreads(prev => Math.max(4, Math.min(16, Math.floor(prev + (Math.random() - 0.5) * 3))));
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setCpuUsage(23);
      setMemoryUsage(42);
      setNetworkLatency(12);
      setActiveThreads(8);
    }
  }, [systemStatus]);

  const metrics = [
    { label: 'CPU_LOAD', value: cpuUsage, unit: '%', max: 100 },
    { label: 'MEMORY', value: memoryUsage, unit: '%', max: 100 },
    { label: 'LATENCY', value: networkLatency, unit: 'ms', max: 100 },
    { label: 'THREADS', value: activeThreads, unit: '', max: 16 },
  ];

  return (
    <div className="grid grid-cols-2 gap-4">
      {metrics.map((metric) => (
        <motion.div
          key={metric.label}
          className="border border-[#CAAA98]/20 bg-[#0a0e1a]/60 p-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="font-mono text-[10px] text-[#9A8678] tracking-widest mb-3">
            {metric.label}
          </div>

          <div className="flex items-end gap-2 mb-2">
            <motion.div
              className="font-mono text-2xl text-[#CAAA98]"
              key={metric.value}
              initial={{ opacity: 0.5 }}
              animate={{ opacity: 1 }}
            >
              {Math.round(metric.value)}
            </motion.div>
            <div className="font-mono text-xs text-[#9A8678] pb-1">{metric.unit}</div>
          </div>

          {/* Progress Bar */}
          <div className="h-1 bg-[#202940] overflow-hidden">
            <motion.div
              className="h-full"
              style={{
                backgroundColor: metric.value > 75 ? '#A06A6A' : metric.value > 50 ? '#D4A574' : '#CAAA98',
              }}
              initial={{ width: 0 }}
              animate={{ width: `${(metric.value / metric.max) * 100}%` }}
              transition={{ duration: 0.5 }}
            />
          </div>

          {/* Mini Graph */}
          <div className="mt-3 h-8 flex items-end gap-px">
            {Array.from({ length: 20 }).map((_, i) => (
              <motion.div
                key={i}
                className="flex-1 bg-[#CAAA98]/20"
                animate={{
                  height: systemStatus === 'healing'
                    ? `${Math.random() * 100}%`
                    : '30%',
                }}
                transition={{
                  duration: 0.5,
                  delay: i * 0.05,
                  repeat: systemStatus === 'healing' ? Infinity : 0,
                  repeatDelay: 1,
                }}
              />
            ))}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
