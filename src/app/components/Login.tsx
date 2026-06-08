import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, Lock, Network } from 'lucide-react';
import { apiLogin, apiRegister, saveToken } from '../lib/backendApi';

interface LoginProps {
  onLoginSuccess: () => void;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface NeuralNode {
  x: number;
  y: number;
  id: number;
}

export function Login({ onLoginSuccess }: LoginProps) {
  const [isActivated, setIsActivated] = useState(false);
  const [tab, setTab] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const nodes: NeuralNode[] = [];
    for (let i = 0; i < 50; i++) {
      nodes.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, id: i });
    }

    const particles: Particle[] = [];
    for (let i = 0; i < 30; i++) {
      particles.push({
        id: i,
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
      });
    }

    let animationId: number;
    const animate = () => {
      ctx.fillStyle = 'rgba(32, 41, 64, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.strokeStyle = 'rgba(154, 134, 120, 0.15)';
      ctx.lineWidth = 0.5;
      nodes.forEach((node, i) => {
        nodes.slice(i + 1).forEach((other) => {
          const dx = node.x - other.x;
          const dy = node.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            ctx.beginPath();
            ctx.moveTo(node.x, node.y);
            ctx.lineTo(other.x, other.y);
            ctx.globalAlpha = 1 - dist / 150;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        });
      });

      nodes.forEach((node) => {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(202, 170, 152, 0.6)';
        ctx.fill();
      });

      particles.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(202, 170, 152, 0.8)';
        ctx.fill();
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 15);
        gradient.addColorStop(0, 'rgba(202, 170, 152, 0.3)');
        gradient.addColorStop(1, 'rgba(202, 170, 152, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(p.x - 15, p.y - 15, 30, 30);
      });

      animationId = requestAnimationFrame(animate);
    };
    animate();

    const handleResize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    window.addEventListener('resize', handleResize);
    return () => { cancelAnimationFrame(animationId); window.removeEventListener('resize', handleResize); };
  }, []);

  const handleSubmit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('AUTHENTICATION_FAILURE :: FIELDS_REQUIRED');
      return;
    }
    if (tab === 'signup' && password !== confirmPassword) {
      setError('REGISTRATION_FAILURE :: PASSWORD_MISMATCH');
      return;
    }

    setIsLoading(true);
    try {
      const data = tab === 'signup'
        ? await apiRegister(email, password, name)
        : await apiLogin(email, password);
      saveToken(data.token);
      setIsLoading(false);
      setIsInitializing(true);
      setTimeout(() => { onLoginSuccess(); }, 4000);
    } catch (err) {
      setIsLoading(false);
      setError(err instanceof Error ? err.message : 'CONNECTION_FAILURE');
    }
  };

  const switchTab = (t: 'login' | 'signup') => {
    setTab(t);
    setError('');
    setEmail('');
    setPassword('');
    setName('');
    setConfirmPassword('');
  };

  const inputClass = 'w-full bg-[#202940]/40 border border-[#9A8678]/30 text-[#CAAA98] py-3 px-4 focus:outline-none focus:border-[#CAAA98] transition-colors placeholder:text-[#9A8678]/30 font-mono text-sm';

  return (
    <div className={`relative w-full bg-[#0a0e1a] ${isActivated ? 'min-h-screen overflow-y-auto' : 'h-screen overflow-hidden'}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ background: 'linear-gradient(135deg, #0a0e1a 0%, #202940 100%)' }}
      />

      <div className="absolute inset-0 opacity-5">
        <svg width="100%" height="100%">
          <defs>
            <pattern id="hexagons" width="50" height="43.4" patternUnits="userSpaceOnUse" patternTransform="scale(2)">
              <polygon points="24.8,22 37.3,14.4 37.3,0.8 24.8,0 12.3,0.8 12.3,14.4" fill="none" stroke="#CAAA98" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#hexagons)" />
        </svg>
      </div>

      <div className={`relative z-10 flex flex-col items-center ${isActivated ? 'pt-52 pb-12' : 'justify-center h-full'}`}>

        {/* Header */}
        <motion.div
          className="absolute top-24 left-1/2 -translate-x-1/2 text-center"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
        >
          <div className="font-mono text-[#9A8678] text-xs mb-2">NEURAL AUTONOMOUS SYSTEM</div>
          <div className="flex items-center gap-3 justify-center">
            <div className="h-px w-16 bg-gradient-to-r from-transparent to-[#CAAA98]" />
            <h1 className="text-5xl font-light tracking-[0.3em] text-[#CAAA98]">AEGIS</h1>
            <div className="h-px w-16 bg-gradient-to-l from-transparent to-[#CAAA98]" />
          </div>
          <div className="font-mono text-[#9A8678] text-xs mt-2 tracking-widest">SELF-HEALING INFRASTRUCTURE CORE</div>
        </motion.div>

        {/* Neural Core */}
        <motion.div
          className="relative flex flex-col items-center"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 1 }}
        >
          <div className="relative w-64 h-64 flex items-center justify-center">
            {[0, 1, 2].map((ring) => (
              <motion.div
                key={ring}
                className="absolute"
                style={{ width: `${200 - ring * 40}px`, height: `${200 - ring * 40}px` }}
                animate={{ rotate: ring % 2 === 0 ? 360 : -360 }}
                transition={{ duration: 20 + ring * 10, repeat: Infinity, ease: 'linear' }}
              >
                <svg viewBox="0 0 100 100" className="w-full h-full">
                  <polygon points="50,5 85,25 85,75 50,95 15,75 15,25" fill="none" stroke="#CAAA98" strokeWidth="0.3" opacity={0.3 - ring * 0.08} />
                </svg>
              </motion.div>
            ))}

            <motion.div
              className="relative z-10 flex flex-col items-center justify-center"
              animate={{ scale: [1, 1.05, 1] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
            >
              <div className="relative">
                <Network className="w-16 h-16 text-[#CAAA98]" strokeWidth={1} />
                <motion.div
                  className="absolute inset-0"
                  animate={{ boxShadow: ['0 0 20px rgba(202,170,152,0.3)', '0 0 40px rgba(202,170,152,0.6)', '0 0 20px rgba(202,170,152,0.3)'] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              </div>
            </motion.div>

            {[0, 120, 240].map((angle) => (
              <motion.div
                key={angle}
                className="absolute w-2 h-2 bg-[#CAAA98] rounded-full"
                style={{ left: '50%', top: '50%' }}
                animate={{
                  x: Math.cos((angle * Math.PI) / 180) * 80,
                  y: Math.sin((angle * Math.PI) / 180) * 80,
                  rotate: 360,
                }}
                transition={{ rotate: { duration: 8, repeat: Infinity, ease: 'linear' } }}
              />
            ))}
          </div>

          <motion.div
            className="font-mono text-[#9A8678] text-xs mt-8 tracking-wider"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          >
            {!isActivated ? '[ STANDBY ] AWAITING_INITIALIZATION...' : '[ ACTIVE ] AUTHENTICATION_REQUIRED'}
          </motion.div>
        </motion.div>

        {/* Form Area */}
        <div className="mt-16 w-full max-w-lg px-8">
          <AnimatePresence mode="wait">
            {!isActivated ? (
              <motion.button
                key="initialize"
                onClick={() => setIsActivated(true)}
                className="w-full py-4 px-8 font-mono text-sm tracking-widest border border-[#CAAA98]/40 bg-[#CAAA98]/5 text-[#CAAA98] hover:bg-[#CAAA98]/10 hover:border-[#CAAA98] transition-all duration-300 relative overflow-hidden"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ delay: 0.8 }}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
              >
                <motion.div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-[#CAAA98]/20 to-transparent"
                  animate={{ x: ['-100%', '200%'] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                />
                <span className="relative z-10">&gt; INITIALIZE_ACCESS_PROTOCOL</span>
              </motion.button>
            ) : (
              <motion.div
                key="form-container"
                className="border border-[#CAAA98]/20 bg-[#0a0e1a]/80 backdrop-blur-sm"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.5 }}
              >
                {/* Tab Switcher */}
                <div className="p-2 border-b border-[#CAAA98]/20">
                  <div className="flex bg-[#202940]/60 p-1 gap-1">
                    {(['login', 'signup'] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => switchTab(t)}
                        className={`flex-1 py-2.5 font-mono text-xs tracking-widest transition-all duration-200 ${
                          tab === t
                            ? 'bg-[#CAAA98] text-[#0a0e1a]'
                            : 'text-[#9A8678] hover:text-[#CAAA98]'
                        }`}
                      >
                        {t === 'login' ? 'LOGIN' : 'SIGNUP'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="p-8 space-y-5">
                  <AnimatePresence mode="wait">
                    {tab === 'signup' && (
                      <motion.div
                        key="name"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <label className="font-mono text-xs text-[#9A8678] tracking-wider mb-2 block">OPERATOR_NAME</label>
                        <input
                          type="text"
                          value={name}
                          onChange={e => setName(e.target.value)}
                          placeholder="Full name"
                          className={inputClass}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div>
                    <label className="font-mono text-xs text-[#9A8678] tracking-wider mb-2 block">OPERATOR_EMAIL</label>
                    <input
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="user@domain.com"
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label className="font-mono text-xs text-[#9A8678] tracking-wider mb-2 block">ACCESS_KEY</label>
                    <div className="relative">
                      <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        placeholder="••••••••••••••••"
                        className={inputClass}
                      />
                      <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9A8678]" />
                    </div>
                  </div>

                  <AnimatePresence mode="wait">
                    {tab === 'signup' && (
                      <motion.div
                        key="confirm"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <label className="font-mono text-xs text-[#9A8678] tracking-wider mb-2 block">CONFIRM_ACCESS_KEY</label>
                        <div className="relative">
                          <input
                            type="password"
                            value={confirmPassword}
                            onChange={e => setConfirmPassword(e.target.value)}
                            placeholder="••••••••••••••••"
                            className={inputClass}
                          />
                          <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9A8678]" />
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Error */}
                  <AnimatePresence>
                    {error && (
                      <motion.div
                        className="border border-[#A06A6A]/50 bg-[#A06A6A]/10 p-3 font-mono text-xs text-[#A06A6A] tracking-wider"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                      >
                        {error}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Submit */}
                  <motion.button
                    type="submit"
                    disabled={isLoading}
                    className="w-full py-4 font-mono text-sm tracking-widest border border-[#CAAA98] bg-[#CAAA98]/10 text-[#CAAA98] hover:bg-[#CAAA98] hover:text-[#0a0e1a] transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed relative overflow-hidden"
                    whileHover={{ scale: isLoading ? 1 : 1.01 }}
                    whileTap={{ scale: isLoading ? 1 : 0.99 }}
                  >
                    {!isLoading && (
                      <motion.div
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-[#CAAA98]/30 to-transparent"
                        animate={{ x: ['-100%', '200%'] }}
                        transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                      />
                    )}
                    <span className="relative z-10">
                      {isLoading
                        ? '[ AUTHENTICATING... ]'
                        : tab === 'login'
                        ? '> ESTABLISH_CONNECTION'
                        : '> CREATE_ACCESS_PROFILE'
                      }
                    </span>
                  </motion.button>

                  {/* Switch prompt */}
                  <div className="text-center font-mono text-[10px] text-[#9A8678]/50 tracking-wider">
                    {tab === 'login' ? (
                      <>NO_PROFILE? <button type="button" onClick={() => switchTab('signup')} className="text-[#CAAA98]/60 hover:text-[#CAAA98] underline underline-offset-2 transition-colors">REGISTER_ACCESS</button></>
                    ) : (
                      <>HAVE_PROFILE? <button type="button" onClick={() => switchTab('login')} className="text-[#CAAA98]/60 hover:text-[#CAAA98] underline underline-offset-2 transition-colors">ESTABLISH_CONNECTION</button></>
                    )}
                  </div>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Initialization Overlay */}
      <AnimatePresence>
        {isInitializing && (
          <motion.div
            className="absolute inset-0 z-50 bg-[#0a0e1a] flex items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="w-full max-w-2xl px-8">
              <div className="text-center mb-12">
                <motion.div
                  className="w-32 h-32 mx-auto relative"
                  animate={{ rotate: 360 }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
                >
                  <svg viewBox="0 0 100 100" className="w-full h-full">
                    <polygon points="50,5 85,25 85,75 50,95 15,75 15,25" fill="none" stroke="#CAAA98" strokeWidth="0.5" opacity="0.6" />
                    <polygon points="50,15 75,28 75,72 50,85 25,72 25,28" fill="none" stroke="#CAAA98" strokeWidth="0.5" opacity="0.8" />
                  </svg>
                  <motion.div
                    className="absolute inset-0 flex items-center justify-center"
                    animate={{ scale: [1, 1.1, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    <Network className="w-12 h-12 text-[#CAAA98]" strokeWidth={1} />
                  </motion.div>
                </motion.div>
              </div>

              <div className="space-y-4 font-mono">
                {[
                  { label: 'AUTHENTICATION', sub: 'Verifying credentials...', delay: 0 },
                  { label: 'NEURAL_CORE', sub: 'Initializing neural pathways...', delay: 0.8 },
                  { label: 'PERMISSIONS', sub: 'Loading access control matrix...', delay: 1.6 },
                  { label: 'ENCRYPTION', sub: 'Establishing secure channel...', delay: 2.4 },
                  { label: 'SESSION', sub: 'Allocating resources...', delay: 3.2 },
                ].map((step) => (
                  <motion.div
                    key={step.label}
                    className="border-l-2 border-[#CAAA98]/20 pl-4"
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: step.delay }}
                  >
                    <div className="flex items-center gap-3 mb-1">
                      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: step.delay + 0.3 }}>
                        <CheckCircle2 className="w-4 h-4 text-[#CAAA98]" />
                      </motion.div>
                      <span className="text-[#CAAA98] text-sm tracking-wider">{step.label}</span>
                      <motion.span
                        className="text-[#9A8678] text-xs"
                        animate={{ opacity: [0.3, 1, 0.3] }}
                        transition={{ duration: 1.5, repeat: Infinity, delay: step.delay }}
                      >
                        OK
                      </motion.span>
                    </div>
                    <div className="text-[#9A8678]/60 text-xs tracking-wide pl-7">{step.sub}</div>
                    <motion.div
                      className="h-px bg-[#CAAA98] mt-2 ml-7"
                      initial={{ width: 0 }}
                      animate={{ width: '100%' }}
                      transition={{ delay: step.delay, duration: 0.6, ease: 'easeOut' }}
                    />
                  </motion.div>
                ))}
              </div>

              <motion.div
                className="mt-8 text-center font-mono text-xs text-[#CAAA98] tracking-widest"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 3.5 }}
              >
                <motion.span animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1, repeat: Infinity }}>
                  [ SYSTEM_READY ] ESTABLISHING_CONNECTION...
                </motion.span>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
