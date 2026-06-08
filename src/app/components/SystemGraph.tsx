import { motion } from 'motion/react';
import { Activity, Code, AlertTriangle, Wrench, CheckCircle, Cpu, Database, Network } from 'lucide-react';

interface SystemNode {
  id: string;
  label: string;
  tech: string;
  icon: React.ReactNode;
  position: { x: number; y: number };
  status: 'idle' | 'active' | 'error' | 'success' | 'processing';
}

interface Connection {
  from: string;
  to: string;
  status: 'idle' | 'active' | 'error' | 'success';
}

interface SystemGraphProps {
  status: 'idle' | 'healing' | 'stopped' | 'healthy';
  activeNode?: string;
}

export function SystemGraph({ status, activeNode }: SystemGraphProps) {
  const nodes: SystemNode[] = [
    {
      id: 'core',
      label: 'NEURAL_CORE',
      tech: 'AI_ENGINE',
      icon: <Network className="w-8 h-8" strokeWidth={1.5} />,
      position: { x: 50, y: 50 },
      status: status === 'healing' ? 'active' : status === 'healthy' ? 'success' : 'idle',
    },
    {
      id: 'code-push',
      label: 'CODE_PUSH',
      tech: 'GIT_HOOK',
      icon: <Code className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 25, y: 20 },
      status: activeNode === 'code-push' ? 'active' : 'idle',
    },
    {
      id: 'pipeline',
      label: 'PIPELINE',
      tech: 'CI/CD',
      icon: <Cpu className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 75, y: 20 },
      status: activeNode === 'pipeline' ? 'error' : 'idle',
    },
    {
      id: 'error-detection',
      label: 'DETECTION',
      tech: 'ANALYZER',
      icon: <AlertTriangle className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 15, y: 70 },
      status: activeNode === 'error-detection' ? 'active' : 'idle',
    },
    {
      id: 'fix-engine',
      label: 'FIX_ENGINE',
      tech: 'REPAIR',
      icon: <Wrench className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 85, y: 70 },
      status: activeNode === 'fix-engine' ? 'processing' : 'idle',
    },
    {
      id: 'validation',
      label: 'VALIDATION',
      tech: 'VERIFY',
      icon: <CheckCircle className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 50, y: 85 },
      status: 'idle',
    },
    {
      id: 'database',
      label: 'DATA_STORE',
      tech: 'MEMORY',
      icon: <Database className="w-5 h-5" strokeWidth={1.5} />,
      position: { x: 50, y: 15 },
      status: 'idle',
    },
  ];

  const connections: Connection[] = [
    { from: 'code-push', to: 'core', status: activeNode === 'code-push' ? 'active' : 'idle' },
    { from: 'database', to: 'core', status: 'idle' },
    { from: 'core', to: 'pipeline', status: activeNode === 'pipeline' ? 'error' : 'idle' },
    { from: 'pipeline', to: 'error-detection', status: activeNode === 'error-detection' ? 'active' : 'idle' },
    { from: 'error-detection', to: 'core', status: activeNode === 'error-detection' ? 'active' : 'idle' },
    { from: 'core', to: 'fix-engine', status: activeNode === 'fix-engine' ? 'active' : 'idle' },
    { from: 'fix-engine', to: 'validation', status: 'idle' },
    { from: 'validation', to: 'pipeline', status: 'idle' },
  ];

  const getNodeColor = (nodeStatus: SystemNode['status']) => {
    switch (nodeStatus) {
      case 'active':
        return '#CAAA98';
      case 'error':
        return '#A06A6A';
      case 'success':
        return '#6A9A7A';
      case 'processing':
        return '#D4A574';
      default:
        return '#9A8678';
    }
  };

  const getConnectionColor = (connStatus: Connection['status']) => {
    switch (connStatus) {
      case 'active':
        return '#CAAA98';
      case 'error':
        return '#A06A6A';
      case 'success':
        return '#6A9A7A';
      default:
        return '#9A8678';
    }
  };

  const getNodeById = (id: string) => nodes.find(n => n.id === id);

  return (
    <div className="relative w-full h-full">
      {/* Background Grid */}
      <div className="absolute inset-0 opacity-5">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="graph-grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#CAAA98" strokeWidth="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#graph-grid)" />
        </svg>
      </div>

      <svg className="absolute inset-0 w-full h-full">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        {/* Draw Connections */}
        {connections.map((conn, index) => {
          const fromNode = getNodeById(conn.from);
          const toNode = getNodeById(conn.to);
          if (!fromNode || !toNode) return null;

          const x1 = `${fromNode.position.x}%`;
          const y1 = `${fromNode.position.y}%`;
          const x2 = `${toNode.position.x}%`;
          const y2 = `${toNode.position.y}%`;

          return (
            <g key={`${conn.from}-${conn.to}-${index}`}>
              {/* Background line */}
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#9A8678"
                strokeWidth="1"
                strokeOpacity="0.2"
                strokeDasharray="4,4"
              />

              {/* Animated data flow line */}
              {conn.status === 'active' && (
                <motion.line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={getConnectionColor(conn.status)}
                  strokeWidth="2"
                  strokeOpacity="0.8"
                  filter="url(#glow)"
                  initial={{ pathLength: 0 }}
                  animate={{
                    pathLength: [0, 1, 0],
                    strokeOpacity: [0.4, 1, 0.4],
                  }}
                  transition={{
                    duration: 2,
                    repeat: Infinity,
                    ease: 'easeInOut',
                  }}
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Draw Nodes */}
      {nodes.map((node) => (
        <motion.div
          key={node.id}
          className="absolute flex flex-col items-center"
          style={{
            left: `${node.position.x}%`,
            top: `${node.position.y}%`,
            transform: 'translate(-50%, -50%)',
          }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{
            scale: 1,
            opacity: 1,
          }}
          transition={{
            delay: 0.1 * nodes.indexOf(node),
            duration: 0.5,
          }}
        >
          {/* Hexagonal Container */}
          <div className="relative">
            {/* Outer Hexagon */}
            <motion.div
              className={`relative ${node.id === 'core' ? 'w-32 h-32' : 'w-20 h-20'}`}
              animate={{
                rotate: node.status === 'active' || node.status === 'processing' ? 360 : 0,
              }}
              transition={{
                duration: 20,
                repeat: node.status === 'active' || node.status === 'processing' ? Infinity : 0,
                ease: 'linear',
              }}
            >
              <svg viewBox="0 0 100 100" className="w-full h-full">
                <polygon
                  points="50,5 90,25 90,75 50,95 10,75 10,25"
                  fill="rgba(10, 14, 26, 0.8)"
                  stroke={getNodeColor(node.status)}
                  strokeWidth="1"
                  opacity={node.status === 'idle' ? 0.4 : 0.8}
                />
              </svg>
            </motion.div>

            {/* Icon Container */}
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ color: getNodeColor(node.status) }}
            >
              {node.icon}
            </div>

            {/* Active Glow */}
            {(node.status === 'active' || node.status === 'processing') && (
              <motion.div
                className="absolute inset-0"
                style={{
                  boxShadow: `0 0 30px ${getNodeColor(node.status)}`,
                  borderRadius: '50%',
                }}
                animate={{
                  boxShadow: [
                    `0 0 20px ${getNodeColor(node.status)}`,
                    `0 0 40px ${getNodeColor(node.status)}`,
                    `0 0 20px ${getNodeColor(node.status)}`,
                  ],
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                }}
              />
            )}

            {/* Pulsing Ring */}
            {(node.status === 'active' || node.status === 'processing') && (
              <motion.div
                className="absolute -inset-4"
                initial={{ scale: 0.8, opacity: 0.8 }}
                animate={{
                  scale: 1.5,
                  opacity: 0,
                }}
                transition={{
                  duration: 2,
                  repeat: Infinity,
                  ease: 'easeOut',
                }}
              >
                <svg viewBox="0 0 100 100" className="w-full h-full">
                  <polygon
                    points="50,5 90,25 90,75 50,95 10,75 10,25"
                    fill="none"
                    stroke={getNodeColor(node.status)}
                    strokeWidth="1"
                  />
                </svg>
              </motion.div>
            )}
          </div>

          {/* Node Label */}
          <motion.div
            className="mt-4 text-center font-mono"
            style={{ color: getNodeColor(node.status) }}
          >
            <div className="text-[10px] tracking-widest">{node.label}</div>
            <div className="text-[8px] text-[#9A8678] tracking-wider mt-0.5">{node.tech}</div>
          </motion.div>

          {/* Status Indicator */}
          <motion.div
            className={`mt-1 px-2 py-0.5 border font-mono text-[8px] tracking-wider ${
              node.id === 'core' ? 'opacity-100' : 'opacity-60'
            }`}
            style={{
              borderColor: getNodeColor(node.status),
              color: getNodeColor(node.status),
            }}
          >
            {node.status === 'active' && 'ACTIVE'}
            {node.status === 'error' && 'ERROR'}
            {node.status === 'processing' && 'PROC'}
            {node.status === 'success' && 'OK'}
            {node.status === 'idle' && 'IDLE'}
          </motion.div>
        </motion.div>
      ))}

      {/* Stop Condition Overlay */}
      {status === 'stopped' && (
        <motion.div
          className="absolute inset-0 flex items-center justify-center bg-[#0a0e1a]/90 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1 }}
        >
          <motion.div
            className="text-center space-y-6 border border-[#CAAA98]/30 bg-[#0a0e1a]/80 p-12"
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
          >
            <motion.div
              className="w-24 h-24 mx-auto relative"
              animate={{
                rotate: 360,
              }}
              transition={{
                duration: 8,
                repeat: Infinity,
                ease: 'linear',
              }}
            >
              <svg viewBox="0 0 100 100" className="w-full h-full">
                <polygon
                  points="50,5 90,25 90,75 50,95 10,75 10,25"
                  fill="none"
                  stroke="#CAAA98"
                  strokeWidth="0.5"
                  opacity="0.6"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <Activity className="w-10 h-10 text-[#CAAA98]" strokeWidth={1.5} />
              </div>
            </motion.div>
            <div className="font-mono">
              <div className="text-xl text-[#CAAA98] tracking-widest">[ HALTED ]</div>
              <div className="text-xs text-[#9A8678] mt-2 tracking-wider">NO_PROGRESS_DETECTED</div>
              <div className="text-[10px] text-[#9A8678]/60 mt-4">MANUAL_INTERVENTION_REQUIRED</div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}
