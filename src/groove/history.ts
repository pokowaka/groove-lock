import { type DrillId, DRILL_TITLES } from './drills';
import type { GroovePatternId } from './patterns';
import type { Subdivision } from './timeline';

/**
 * What the Coach remembers between sessions: a compact log of every round (for progress over days)
 * and per-drill progress (best level reached, completion days for mastery). Both live in
 * `localStorage`; all functions are pure except the load/save helpers, which take the storage as a
 * parameter so they can be tested.
 */

/** Minimal storage interface (satisfied by `window.localStorage`). */
export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

const HISTORY_KEY = 'groovelock.history.v1';
const COACH_KEY = 'groovelock.coach.v1';
export const HISTORY_LIMIT = 1000;
/** Completing a drill on this many different days marks it mastered. */
export const MASTERY_DAYS = 2;

/** One finished round, summarized. */
export interface RoundRecord {
  /** ISO timestamp of when the round ended. */
  readonly at: string;
  readonly bpm: number;
  readonly groovePattern: GroovePatternId;
  readonly subdivision: Subdivision;
  readonly pocketCenterMs: number;
  readonly pocketWindowMs: number;
  /** Drill the round belonged to, or `null` for your own groove. */
  readonly drillId: DrillId | null;
  readonly drillLevel: number | null;
  readonly hitCount: number;
  readonly expectedCount: number;
  readonly inPocketPct: number;
  readonly meanFeelDeltaMs: number | null;
  readonly sigmaMs: number | null;
  readonly stars: number;
}

export interface DrillProgress {
  /** Highest level index reached (0-based). */
  readonly bestLevel: number;
  /** Number of levels the drill had when last played. */
  readonly levelCount: number;
  /** Distinct local days (`YYYY-MM-DD`) on which the drill was completed. */
  readonly completionDays: readonly string[];
  readonly lastPlayedAt: string | null;
}

export type CoachProgress = Partial<Record<DrillId, DrillProgress>>;

/** Local calendar day as `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Round history
// ---------------------------------------------------------------------------

export function appendRound(history: readonly RoundRecord[], record: RoundRecord): RoundRecord[] {
  return [...history, record].slice(-HISTORY_LIMIT);
}

function isRoundRecord(value: unknown): value is RoundRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const num = (k: string): boolean => typeof r[k] === 'number' && Number.isFinite(r[k]);
  const numOrNull = (k: string): boolean => r[k] === null || num(k);
  return (
    typeof r.at === 'string' &&
    typeof r.groovePattern === 'string' &&
    (r.drillId === null || (typeof r.drillId === 'string' && r.drillId in DRILL_TITLES)) &&
    num('bpm') &&
    num('subdivision') &&
    num('pocketCenterMs') &&
    num('pocketWindowMs') &&
    numOrNull('drillLevel') &&
    num('hitCount') &&
    num('expectedCount') &&
    num('inPocketPct') &&
    numOrNull('meanFeelDeltaMs') &&
    numOrNull('sigmaMs') &&
    num('stars')
  );
}

export function loadHistory(storage: KeyValueStorage): RoundRecord[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isRoundRecord).slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: readonly RoundRecord[], storage: KeyValueStorage): void {
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Ignore quota / private-browsing errors.
  }
}

export interface DaySummary {
  readonly day: string;
  /** Rounds of your own groove (drill rounds excluded). */
  readonly rounds: number;
  readonly avgPocketPct: number | null;
  readonly threeStarRounds: number;
}

/**
 * Per-day summary of your own-groove rounds for the last `days` days, newest first (days without
 * rounds included).
 */
export function summarizeDays(history: readonly RoundRecord[], now: Date, days = 7): DaySummary[] {
  const byDay = new Map<string, RoundRecord[]>();
  for (const r of history) {
    if (r.drillId !== null) continue;
    const day = localDay(new Date(r.at));
    byDay.set(day, [...(byDay.get(day) ?? []), r]);
  }
  const result: DaySummary[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const day = localDay(d);
    const rounds = byDay.get(day) ?? [];
    result.push({
      day,
      rounds: rounds.length,
      avgPocketPct:
        rounds.length > 0
          ? Math.round(rounds.reduce((a, r) => a + r.inPocketPct, 0) / rounds.length)
          : null,
      threeStarRounds: rounds.filter((r) => r.stars >= 3).length,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Drill progress
// ---------------------------------------------------------------------------

/**
 * Records a drill session update.
 *
 * @param update.levelReached Level index the player reached (best is kept).
 * @param update.completed `true` when the top level was passed in this session.
 */
export function updateDrillProgress(
  progress: CoachProgress,
  drillId: DrillId,
  update: { levelReached: number; levelCount: number; completed: boolean; now: Date },
): CoachProgress {
  const prev = progress[drillId];
  const day = localDay(update.now);
  const completionDays = prev?.completionDays ?? [];
  return {
    ...progress,
    [drillId]: {
      bestLevel: Math.max(prev?.bestLevel ?? 0, update.levelReached),
      levelCount: update.levelCount,
      completionDays:
        update.completed && !completionDays.includes(day)
          ? [...completionDays, day]
          : [...completionDays],
      lastPlayedAt: update.now.toISOString(),
    },
  };
}

export function isMastered(progress: CoachProgress, drillId: DrillId): boolean {
  return (progress[drillId]?.completionDays.length ?? 0) >= MASTERY_DAYS;
}

export function masteredDrills(progress: CoachProgress): Set<DrillId> {
  return new Set(
    (Object.keys(progress) as DrillId[]).filter((id) => isMastered(progress, id)),
  );
}

/** Level to start a drill at: one below your best, so the first round is a likely win. */
export function entryLevelFor(progress: CoachProgress, drillId: DrillId, levelCount: number): number {
  const best = progress[drillId]?.bestLevel;
  if (best === undefined) return 0;
  return Math.max(0, Math.min(best, levelCount - 1) - 1);
}

function isDrillProgress(value: unknown): value is DrillProgress {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.bestLevel === 'number' &&
    Number.isInteger(p.bestLevel) &&
    p.bestLevel >= 0 &&
    typeof p.levelCount === 'number' &&
    p.levelCount >= 1 &&
    Array.isArray(p.completionDays) &&
    p.completionDays.every((d) => typeof d === 'string') &&
    (p.lastPlayedAt === null || typeof p.lastPlayedAt === 'string')
  );
}

export function loadCoachProgress(storage: KeyValueStorage): CoachProgress {
  try {
    const parsed = JSON.parse(storage.getItem(COACH_KEY) ?? '{}') as { drills?: Record<string, unknown> };
    const result: CoachProgress = {};
    for (const [id, value] of Object.entries(parsed.drills ?? {})) {
      if (id in DRILL_TITLES && isDrillProgress(value)) {
        result[id as DrillId] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function saveCoachProgress(progress: CoachProgress, storage: KeyValueStorage): void {
  try {
    storage.setItem(COACH_KEY, JSON.stringify({ drills: progress }));
  } catch {
    // Ignore quota / private-browsing errors.
  }
}
