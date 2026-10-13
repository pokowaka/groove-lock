import { describe, expect, it } from 'vitest';
import { type ClockSample, estimateInputDriftMs } from '../src/audio/clock-drift';

/** Builds samples every 250 ms with the given output/input clock behaviour. */
function samples(
  count: number,
  outAt: (wallMs: number) => number,
  inAt: (wallMs: number) => number,
): ClockSample[] {
  return Array.from({ length: count }, (_, i) => {
    const atMs = i * 250;
    return { atMs, outMs: outAt(atMs), inMs: inAt(atMs) };
  });
}

describe('estimateInputDriftMs', () => {
  it('needs enough samples', () => {
    expect(estimateInputDriftMs(samples(5, (t) => t, (t) => t))).toBeNull();
  });

  it('is zero when both clocks run together', () => {
    expect(estimateInputDriftMs(samples(400, (t) => t + 7, (t) => t))).toBeCloseTo(0, 5);
  });

  it('reports input-side buffering as positive drift (input clock falls behind)', () => {
    // input loses 0.1 ms per second -> after 100 s the input delay grew by 10 ms
    const drift = estimateInputDriftMs(samples(400, (t) => t, (t) => t - t * 0.0001));
    expect(drift).toBeGreaterThan(8);
    expect(drift).toBeLessThan(11);
  });

  it('ignores an output dropout (output clock stalls, grading stays consistent)', () => {
    const stallAt = 30000;
    const drift = estimateInputDriftMs(
      samples(400, (t) => (t < stallAt ? t : t - 32), (t) => t),
    );
    expect(Math.abs(drift ?? 99)).toBeLessThan(3);
  });

  it('counts an input stall as drift', () => {
    const stallAt = 30000;
    const drift = estimateInputDriftMs(
      samples(400, (t) => t, (t) => (t < stallAt ? t : t - 25)),
    );
    expect(drift).toBeGreaterThan(22);
  });
});
