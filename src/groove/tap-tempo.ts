/** Taps separated by more than this start a new tempo measurement. */
export const TAP_RESET_GAP_MS = 2000;
const MAX_INTERVALS = 4;
const MIN_BPM = 40;
const MAX_BPM = 200;

/**
 * Derives a tempo from tap timestamps.
 *
 * @param tapTimesMs Tap timestamps in milliseconds, oldest first.
 * @return Rounded BPM clamped to 40–200, or `null` until two taps belong to the same run.
 */
export function computeTapTempoBpm(tapTimesMs: readonly number[]): number | null {
  let runStart = 0;
  for (let i = 1; i < tapTimesMs.length; i++) {
    if (tapTimesMs[i] - tapTimesMs[i - 1] > TAP_RESET_GAP_MS) {
      runStart = i;
    }
  }
  const run = tapTimesMs.slice(runStart).slice(-(MAX_INTERVALS + 1));
  if (run.length < 2) {
    return null;
  }
  const avgIntervalMs = (run[run.length - 1] - run[0]) / (run.length - 1);
  const bpm = Math.round(60000 / avgIntervalMs);
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}
