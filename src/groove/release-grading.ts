/**
 * Note-length grading: when a note ends, compared with its written length.
 *
 * A note's target end is its target onset (plus the feel offset) plus its written length. The
 * release uses the same latency compensation as onsets. Release detection is accurate to about
 * ±10–15 ms, so the window is wider than the onset pocket.
 */

export type ReleaseJudgment = 'short' | 'on-time' | 'long';

export interface ReleaseHit {
  readonly stepKey: string;
  readonly stepName: string;
  /** Signed release error in ms (negative = cut short). */
  readonly deltaMs: number;
  readonly judgment: ReleaseJudgment;
}

/** Release tolerance (± ms) for a given onset pocket window. */
export function releaseWindowMs(pocketWindowMs: number): number {
  return Math.max(30, 2 * pocketWindowMs);
}

export function gradeRelease(input: {
  readonly releaseTimeSec: number;
  readonly latencyCompensationMs: number;
  readonly targetTimeSec: number;
  readonly pocketCenterMs: number;
  readonly lengthBeats: number;
  readonly bpm: number;
  readonly windowMs: number;
}): { deltaMs: number; judgment: ReleaseJudgment; targetEndSec: number } {
  const targetEndSec =
    input.targetTimeSec + input.pocketCenterMs / 1000 + (input.lengthBeats * 60) / input.bpm;
  const heardSec = input.releaseTimeSec - input.latencyCompensationMs / 1000;
  const deltaMs = Math.round((heardSec - targetEndSec) * 10000) / 10;
  const judgment: ReleaseJudgment =
    deltaMs < -input.windowMs ? 'short' : deltaMs > input.windowMs ? 'long' : 'on-time';
  return { deltaMs, judgment, targetEndSec };
}

export interface ReleaseSummary {
  readonly count: number;
  /** Share of notes that ended inside the window (`0..100`). */
  readonly onTimePct: number;
  readonly meanDeltaMs: number | null;
  readonly shortCount: number;
  readonly longCount: number;
}

export function summarizeReleases(hits: readonly ReleaseHit[]): ReleaseSummary {
  const count = hits.length;
  const onTime = hits.filter((h) => h.judgment === 'on-time').length;
  return {
    count,
    onTimePct: count > 0 ? Math.round((onTime / count) * 100) : 0,
    meanDeltaMs: count > 0 ? hits.reduce((a, h) => a + h.deltaMs, 0) / count : null,
    shortCount: hits.filter((h) => h.judgment === 'short').length,
    longCount: hits.filter((h) => h.judgment === 'long').length,
  };
}

/** One line for the results card, or `null` when no note lengths were graded. */
export function describeReleases(s: ReleaseSummary): string | null {
  if (s.count === 0 || s.meanDeltaMs === null) {
    return null;
  }
  const head = `Note lengths: ${s.onTimePct}% on time`;
  if (s.onTimePct >= 80) {
    return `${head}. Clean.`;
  }
  const ms = Math.round(Math.abs(s.meanDeltaMs));
  return s.meanDeltaMs < 0
    ? `${head} · you cut notes short by ${ms} ms on average`
    : `${head} · you hold notes ${ms} ms too long on average`;
}
