import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The hook wraps the backend event API so history failures never block a heal.
// A rename once made these wrappers call themselves (infinite recursion that
// froze every heal on its first step) — keep them pointed at the real API.
describe('useHealingProcess event wrappers', () => {
  const src = readFileSync('src/app/hooks/useHealingProcess.ts', 'utf8');
  const body = (name: string) => {
    const start = src.indexOf(`const ${name} = async`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n    };', start));
  };

  it('createEvent delegates to apiCreateEvent', () => {
    const b = body('createEvent');
    expect(b).toContain('await apiCreateEvent(ev)');
    expect(b).not.toMatch(/[^.\w]createEvent\(/);
  });

  it('updateEvent delegates to apiUpdateEvent', () => {
    const b = body('updateEvent');
    expect(b).toContain('await apiUpdateEvent(id, patch)');
    expect(b).not.toMatch(/[^.\w]updateEvent\(/);
  });
});
