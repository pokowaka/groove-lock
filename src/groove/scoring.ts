import type { Subdivision } from './timeline';

/**
 * Pure, DOM-free scoring rules that turn graded plucks into the musical feedback shown by the
 * Play view: per-hit judgments, the σ-driven Groove Meter, in-pocket streaks, and end-of-round
 * summaries with stars and a single coaching tip.
 *
 * All timing inputs are signed milliseconds where negative = early (rushing) and positive = late
 * (dragging). "Feel delta" means the offset relative to the intentional pocket center
 * (`offsetMs - pocketCenterMs`), so a steady laid-back player has feel deltas near zero.
 */

/** Musical judgment for a single graded hit. */
export type HitJudgment = 'locked' | 'pocket' | 'rushed' | 'dragged';

/** Fraction of the pocket window that counts as a "locked" (near-perfect) hit. */
export const LOCKED_WINDOW_FRACTION = 0.4;

/**
 * Classifies a hit relative to the pocket window.
 *
 * @param feelDeltaMs Signed offset from the intentional pocket center.
 * @param pocketWindowMs Half-width of the in-pocket tolerance window.
 * @return `'locked'` within 40% of the window, `'pocket'` within the window, otherwise the direction.
 */
export function judgeHit(feelDeltaMs: number, pocketWindowMs: number): HitJudgment {
  const abs = Math.abs(feelDeltaMs);
  if (abs <= pocketWindowMs * LOCKED_WINDOW_FRACTION) {
    return 'locked';
  }
  if (abs <= pocketWindowMs) {
    return 'pocket';
  }
  return feelDeltaMs < 0 ? 'rushed' : 'dragged';
}

/** Consistency tier displayed by the Groove Meter, ordered from best to worst. */
export type GrooveTier = 'machine' | 'tight' | 'solid' | 'loose' | 'wobbly';

const GROOVE_TIER_LIMITS: ReadonlyArray<readonly [GrooveTier, number]> = [
  ['machine', 5],
  ['tight', 9],
  ['solid', 15],
  ['loose', 24],
];

/** σ (ms) at which the Groove Meter reads empty. */
const GROOVE_METER_EMPTY_SIGMA_MS = 30;
const GROOVE_METER_MIN_SAMPLES = 4;

/** Snapshot of the Groove Meter. */
export interface GrooveMeterReading {
  /** Standard deviation of the recent offsets, or `null` with too few samples. */
  readonly sigmaMs: number | null;
  /** Consistency tier, or `null` with too few samples. */
  readonly tier: GrooveTier | null;
  /** Meter fill in `[0, 1]` (1 = perfectly steady). */
  readonly fill: number;
  /** Number of offsets considered. */
  readonly sampleCount: number;
}

/**
 * Population standard deviation.
 *
 * @param values Samples; must be non-empty.
 */
export function standardDeviation(values: readonly number[]): number {
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Computes the Groove Meter from recent timing offsets. Only spread matters: a constant offset
 * (deliberately laid back or pushed) does not reduce the reading.
 *
 * @param offsetsMs Offsets in chronological order (oldest first).
 * @param windowSize Number of most recent offsets to consider.
 */
export function computeGrooveMeter(
  offsetsMs: readonly number[],
  windowSize = 16,
): GrooveMeterReading {
  const recent = offsetsMs.slice(-windowSize);
  if (recent.length < GROOVE_METER_MIN_SAMPLES) {
    return { sigmaMs: null, tier: null, fill: 0, sampleCount: recent.length };
  }
  const sigmaMs = standardDeviation(recent);
  const tier =
    GROOVE_TIER_LIMITS.find(([, limit]) => sigmaMs <= limit)?.[0] ?? 'wobbly';
  const fill = Math.min(1, Math.max(0, 1 - sigmaMs / GROOVE_METER_EMPTY_SIGMA_MS));
  return { sigmaMs, tier, fill, sampleCount: recent.length };
}

/**
 * Tracks consecutive successful hits.
 *
 * Invariant: `0 <= current <= best`.
 */
export class StreakTracker {
  private currentCount = 0;
  private bestCount = 0;

  public get current(): number {
    return this.currentCount;
  }

  public get best(): number {
    return this.bestCount;
  }

  /** Records one hit; a failure resets the current streak. */
  public record(success: boolean): void {
    this.currentCount = success ? this.currentCount + 1 : 0;
    this.bestCount = Math.max(this.bestCount, this.currentCount);
  }

  public reset(): void {
    this.currentCount = 0;
    this.bestCount = 0;
  }
}

const SUBDIVISION_SYLLABLES: Readonly<Record<Subdivision, readonly string[]>> = {
  1: [''],
  2: ['', '&'],
  3: ['', 'trip', 'let'],
  4: ['', 'e', '&', 'a'],
};

/**
 * Musician-readable step name used in coaching tips (e.g. `"beat 1"`, `"4-&"`, `"2-a"`).
 */
export function formatStepName(
  beatInBar: number,
  subIndex: number,
  subdivision: Subdivision,
): string {
  if (subIndex === 0) {
    return `beat ${beatInBar + 1}`;
  }
  const syllable = SUBDIVISION_SYLLABLES[subdivision][subIndex] ?? String(subIndex + 1);
  return `${beatInBar + 1}-${syllable}`;
}

/** Stable key identifying a step position within a bar. */
export function stepKeyOf(beatInBar: number, subIndex: number): string {
  return `${beatInBar}:${subIndex}`;
}

/** One graded hit inside a round, reduced to what scoring needs. */
export interface RoundHit {
  readonly stepKey: string;
  readonly stepName: string;
  readonly offsetMs: number;
  readonly feelDeltaMs: number;
  readonly inPocket: boolean;
  readonly noteMatched: boolean;
  /** `true` if the click was muted (Gap Click trainer) during this hit's bar. */
  readonly inSilentBar?: boolean;
}

/** Per-step aggregate of feel deltas. */
export interface StepAggregate {
  readonly stepName: string;
  readonly count: number;
  readonly meanFeelDeltaMs: number;
}

/** Groups hits by step and averages their feel deltas. */
export function aggregateByStep(
  hits: readonly RoundHit[],
): Map<string, StepAggregate> {
  const sums = new Map<string, { stepName: string; count: number; sum: number }>();
  for (const h of hits) {
    const acc = sums.get(h.stepKey) ?? { stepName: h.stepName, count: 0, sum: 0 };
    acc.count++;
    acc.sum += h.feelDeltaMs;
    sums.set(h.stepKey, acc);
  }
  const result = new Map<string, StepAggregate>();
  for (const [key, acc] of sums) {
    result.set(key, {
      stepName: acc.stepName,
      count: acc.count,
      meanFeelDeltaMs: acc.sum / acc.count,
    });
  }
  return result;
}

/** Star rating for a round (0–3). */
export type StarRating = 0 | 1 | 2 | 3;

/** End-of-round results shown on the results card. */
export interface RoundSummary {
  readonly hitCount: number;
  readonly expectedCount: number;
  /** Hits that were in the pocket with the right note, over max(expected, hits). */
  readonly inPocketPct: number;
  readonly meanFeelDeltaMs: number | null;
  readonly sigmaMs: number | null;
  readonly bestStreak: number;
  readonly stars: StarRating;
  /** The step with the largest average deviation (needs ≥ 2 hits), if any. */
  readonly worstStep: StepAggregate | null;
  /** One actionable coaching sentence. */
  readonly tip: string;
}

const MIN_HITS_PER_STEP_FOR_TIP = 2;
const MISSED_NOTES_TIP_RATIO = 0.75;

/**
 * Summarizes a finished round.
 *
 * @param hits All graded hits of the round, in chronological order.
 * @param opts.pocketWindowMs Tolerance half-window used for grading.
 * @param opts.expectedTargetCount Number of target notes the round asked for (misses count against the score).
 */
export function summarizeRound(
  hits: readonly RoundHit[],
  opts: { pocketWindowMs: number; expectedTargetCount: number },
): RoundSummary {
  const w = opts.pocketWindowMs;
  const hitCount = hits.length;
  const denominator = Math.max(opts.expectedTargetCount, hitCount, 1);

  let good = 0;
  const streak = new StreakTracker();
  for (const h of hits) {
    const ok = h.inPocket && h.noteMatched;
    if (ok) {
      good++;
    }
    streak.record(ok);
  }
  const inPocketPct = Math.round((good / denominator) * 100);

  const deltas = hits.map((h) => h.feelDeltaMs);
  const meanFeelDeltaMs =
    hitCount > 0 ? deltas.reduce((a, v) => a + v, 0) / hitCount : null;
  const sigmaMs = hitCount >= 2 ? standardDeviation(deltas) : null;

  let stars: StarRating = 0;
  if (inPocketPct >= 85 && sigmaMs !== null && sigmaMs <= w * 0.75) {
    stars = 3;
  } else if (inPocketPct >= 65) {
    stars = 2;
  } else if (inPocketPct >= 40) {
    stars = 1;
  }

  let worstStep: StepAggregate | null = null;
  for (const agg of aggregateByStep(hits).values()) {
    if (agg.count < MIN_HITS_PER_STEP_FOR_TIP) {
      continue;
    }
    if (!worstStep || Math.abs(agg.meanFeelDeltaMs) > Math.abs(worstStep.meanFeelDeltaMs)) {
      worstStep = agg;
    }
  }

  return {
    hitCount,
    expectedCount: opts.expectedTargetCount,
    inPocketPct,
    meanFeelDeltaMs,
    sigmaMs,
    bestStreak: streak.best,
    stars,
    worstStep,
    tip: chooseCoachingTip({
      hitCount,
      expectedCount: opts.expectedTargetCount,
      meanFeelDeltaMs,
      sigmaMs,
      worstStep,
      pocketWindowMs: w,
    }),
  };
}

function chooseCoachingTip(s: {
  hitCount: number;
  expectedCount: number;
  meanFeelDeltaMs: number | null;
  sigmaMs: number | null;
  worstStep: StepAggregate | null;
  pocketWindowMs: number;
}): string {
  const w = s.pocketWindowMs;
  if (s.hitCount === 0 || s.meanFeelDeltaMs === null) {
    return 'No notes detected. Check your input level and sensitivity in Setup.';
  }
  if (s.expectedCount > 0 && s.hitCount < s.expectedCount * MISSED_NOTES_TIP_RATIO) {
    const missed = s.expectedCount - s.hitCount;
    return `You missed ${missed} of ${s.expectedCount} notes. Try a slower tempo or a simpler pattern.`;
  }
  const mean = s.meanFeelDeltaMs;
  if (
    s.worstStep &&
    Math.abs(s.worstStep.meanFeelDeltaMs) > w * 0.5 &&
    Math.abs(s.worstStep.meanFeelDeltaMs - mean) > w * 0.4
  ) {
    const ms = Math.round(Math.abs(s.worstStep.meanFeelDeltaMs));
    const verb = s.worstStep.meanFeelDeltaMs < 0 ? 'rush' : 'drag';
    return `You ${verb} the ${s.worstStep.stepName} by ${ms} ms on average. Feel it a hair ${verb === 'rush' ? 'later' : 'earlier'}.`;
  }
  if (Math.abs(mean) > w * 0.5) {
    const ms = Math.round(Math.abs(mean));
    return mean < 0
      ? `Overall you sit ${ms} ms ahead of your target feel. Relax into the beat.`
      : `Overall you sit ${ms} ms behind your target feel. Lean in a little.`;
  }
  if (s.sigmaMs !== null && s.sigmaMs > w * 0.75) {
    return `Centered but uneven (σ ${s.sigmaMs.toFixed(1)} ms). Aim for consistency over accuracy.`;
  }
  return 'Rock solid. Try a sparser click or a faster tempo next.';
}
