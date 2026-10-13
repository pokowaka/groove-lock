import type { RoundSummary } from './scoring';

/**
 * Latency calibration rules. Total latency (output → ears → hands → pickup → input) varies a lot
 * between setups; some Bluetooth/aggregate/browser paths exceed 250 ms. The supported range and the
 * tap-acceptance window are wide enough for those, and calibration runs at a slow tempo so a large
 * delay can't be mistaken for the neighbouring beat.
 */

export const LATENCY_MIN_MS = -50;
export const LATENCY_MAX_MS = 400;
/** Tap calibration ignores taps further than this from a click (calibration runs at 60 BPM). */
export const CALIBRATION_MAX_TAP_OFFSET_MS = 450;
/** Tempo used for tap calibration: 1000 ms between clicks keeps large latencies unambiguous. */
export const CALIBRATION_BPM = 60;
/** Taps needed to finish tap calibration. */
export const CALIBRATION_TAPS = 8;

/** Average offset beyond which "every note is off" is treated as latency, not musicianship. */
const LATENCY_SUSPECT_MEAN_MS = 60;
const LATENCY_SUSPECT_MIN_HITS = 8;

export function clampLatencyMs(ms: number): number {
  return Math.max(LATENCY_MIN_MS, Math.min(LATENCY_MAX_MS, Math.round(ms)));
}

/**
 * Estimates latency from tap offsets (raw tap time minus click time), dropping the fastest and
 * slowest tap when there are enough.
 *
 * @return Rounded, clamped latency in ms, or `null` with fewer than 3 taps.
 */
export function estimateLatencyMs(tapOffsetsMs: readonly number[]): number | null {
  if (tapOffsetsMs.length < 3) {
    return null;
  }
  const sorted = [...tapOffsetsMs].sort((a, b) => a - b);
  const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
  return clampLatencyMs(trimmed.reduce((a, v) => a + v, 0) / trimmed.length);
}

export interface LatencyIssue {
  readonly direction: 'early' | 'late';
  readonly meanMs: number;
  readonly message: string;
}

/**
 * Flags rounds where every note is off by far more than any musical push/lay-back, which points at
 * uncompensated latency rather than the player's timing.
 */
export function detectLatencyIssue(summary: RoundSummary): LatencyIssue | null {
  const mean = summary.meanFeelDeltaMs;
  if (mean === null || summary.hitCount < LATENCY_SUSPECT_MIN_HITS) {
    return null;
  }
  if (Math.abs(mean) < LATENCY_SUSPECT_MEAN_MS) {
    return null;
  }
  const direction = mean > 0 ? 'late' : 'early';
  const ms = Math.round(Math.abs(mean));
  return {
    direction,
    meanMs: Math.round(mean),
    message: `Every note shows up about ${ms} ms ${direction}. That is almost certainly audio latency in your setup, not your playing. Calibrate once and the numbers will be right.`,
  };
}
