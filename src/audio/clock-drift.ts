/**
 * Estimates how much the input delay has changed since a reference point, from periodic snapshots
 * of both audio clocks against wall time.
 *
 * The grader converts input timestamps to the output clock with the live `output − input` offset.
 * That is right when the *output* clock stalls (a dropout delays the clicks and the conversion by
 * the same amount), but wrong when input samples pile up in the browser's buffer: then the input
 * delay grows and grading drifts late by that much. So: offset changes count as drift, except
 * across intervals where the output clock fell behind wall time (output dropouts).
 */

export interface ClockSample {
  /** Wall time (`performance.now()`). */
  readonly atMs: number;
  /** `outputCtx.currentTime` in ms. */
  readonly outMs: number;
  /** `inputCtx.currentTime` in ms. */
  readonly inMs: number;
}

/** Snapshots needed before a drift estimate is reported. */
export const MIN_DRIFT_SAMPLES = 20;
/** An interval where the output clock advanced this much less than wall time is a dropout. */
const OUTPUT_STALL_MS = 10;

/**
 * Drift contributed by one interval between consecutive snapshots: the change of the output-input
 * offset, or 0 when the output clock fell behind wall time (an output dropout).
 */
export function driftContributionMs(prev: ClockSample, cur: ClockSample): number {
  const wall = cur.atMs - prev.atMs;
  const outputLag = wall - (cur.outMs - prev.outMs);
  if (outputLag > OUTPUT_STALL_MS) {
    return 0;
  }
  return cur.outMs - cur.inMs - (prev.outMs - prev.inMs);
}

/**
 * @param samples Snapshots in time order (the first one is the reference point).
 * @return Change of the input delay in ms (positive = input arrives later than at the reference),
 *   or `null` with too few samples.
 */
export function estimateInputDriftMs(samples: readonly ClockSample[]): number | null {
  if (samples.length < MIN_DRIFT_SAMPLES) {
    return null;
  }
  let drift = 0;
  for (let i = 1; i < samples.length; i++) {
    drift += driftContributionMs(samples[i - 1], samples[i]);
  }
  return drift;
}
