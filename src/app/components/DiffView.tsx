import { useMemo } from 'react';
import { diffLines, diffHunks, diffStats } from '../lib/lineDiff';

interface DiffViewProps {
  before: string | null; // null = new file
  after: string;
  maxLines?: number;
}

/** Compact unified diff (3 lines of context) in the dashboard's terminal style. */
export function DiffView({ before, after, maxLines = 400 }: DiffViewProps) {
  const { hunks, stats } = useMemo(() => {
    const lines = diffLines(before ?? '', after);
    return { hunks: diffHunks(lines, 3), stats: diffStats(lines) };
  }, [before, after]);

  if (hunks.length === 0) {
    return <div className="font-mono text-[10px] text-[#9A8678]/50 px-3 py-2">no textual changes</div>;
  }

  let budget = maxLines;
  return (
    <div className="font-mono text-[10px] leading-[1.45] bg-[#070a13] border border-[#CAAA98]/10 overflow-x-auto">
      <div className="flex items-center gap-3 px-3 py-1 border-b border-[#CAAA98]/10 text-[9px] tracking-wider">
        {before === null && <span className="text-[#D4A574]">NEW_FILE</span>}
        <span className="text-[#6A9A7A]">+{stats.added}</span>
        <span className="text-[#A06A6A]">−{stats.removed}</span>
      </div>
      {hunks.map((hunk, hi) => {
        if (budget <= 0) return null;
        const shown = hunk.slice(0, budget);
        budget -= shown.length;
        return (
          <div key={hi} className={hi > 0 ? 'border-t border-dashed border-[#CAAA98]/10' : ''}>
            {shown.map((l, li) => (
              <div
                key={li}
                className="flex whitespace-pre"
                style={{
                  backgroundColor: l.type === 'add' ? 'rgba(106,154,122,0.12)' : l.type === 'del' ? 'rgba(160,106,106,0.14)' : 'transparent',
                  color: l.type === 'add' ? '#8FC49F' : l.type === 'del' ? '#C98E8E' : '#9A8678',
                }}
              >
                <span className="w-9 text-right pr-2 select-none opacity-40 flex-shrink-0">{l.oldNo ?? ''}</span>
                <span className="w-9 text-right pr-2 select-none opacity-40 flex-shrink-0">{l.newNo ?? ''}</span>
                <span className="w-4 select-none flex-shrink-0">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                <span className="pr-3">{l.text || ' '}</span>
              </div>
            ))}
          </div>
        );
      })}
      {budget <= 0 && <div className="px-3 py-1 text-[9px] text-[#9A8678]/50">… diff truncated</div>}
    </div>
  );
}
