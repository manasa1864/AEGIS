import type { HealingEventRecord } from '../types';

export type ErrorLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NO_ERROR';

// Confidence threshold boundaries:
//   >= 82  → LOW    (high-confidence fix applied, likely resolved)
//   >= 65  → MEDIUM (fix applied but uncertain)
//   <  65  → HIGH   (low-confidence or operator-rejected)
const LOW_THRESHOLD = 82;
const MED_THRESHOLD = 65;

export function confidenceToLevel(confidence: number, healed: boolean): ErrorLevel {
  if (!healed) return 'HIGH';
  if (confidence >= LOW_THRESHOLD) return 'LOW';
  if (confidence >= MED_THRESHOLD) return 'MEDIUM';
  return 'HIGH';
}

// Derives error level from the most recent healing event for a repo
export function eventsToErrorLevel(events: HealingEventRecord[]): ErrorLevel {
  if (!events.length) return 'NO_ERROR';
  const latest = events.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );
  if (latest.status === 'healed') return confidenceToLevel(latest.confidence ?? 75, true);
  if (latest.status === 'failed') return 'HIGH';
  if (latest.status === 'healing') return 'MEDIUM';
  return 'NO_ERROR';
}

// Human-readable errorType string written to DB after healing
export function levelToErrorType(level: ErrorLevel): string {
  switch (level) {
    case 'HIGH':     return 'HEAL_FAILED';
    case 'MEDIUM':   return 'CI_FIX_PENDING';
    case 'LOW':      return 'CI_FIX_APPLIED';
    case 'NO_ERROR': return 'CI_HEALTHY';
  }
}
