import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MAX_TAP_OFFSET_MS,
  detectLatencyIssue,
  estimateLatencyMs,
  LATENCY_MAX_MS,
  LATENCY_MIN_MS,
} from '../src/groove/calibration';
import { type RoundHit, summarizeRound } from '../src/groove/scoring';

function summaryOf(deltas: number[]) {
  const hits: RoundHit[] = deltas.map((d) => ({
    stepKey: '0:0',
    stepName: 'beat 1',
    offsetMs: d,
    feelDeltaMs: d,
    inPocket: Math.abs(d) <= 16,
    noteMatched: true,
  }));
  return summarizeRound(hits, { pocketWindowMs: 16, expectedTargetCount: hits.length });
}

describe('estimateLatencyMs', () => {
  it('averages taps after dropping the extremes', () => {
    expect(estimateLatencyMs([250, 252, 248, 251, 249, 250, 400, 100])).toBe(250);
  });

  it('supports large latencies (e.g. 250+ ms setups)', () => {
    expect(estimateLatencyMs([310, 305, 300, 315, 308, 302, 299, 311])).toBe(306);
  });

  it('clamps to the supported range', () => {
    expect(estimateLatencyMs(Array(8).fill(900))).toBe(LATENCY_MAX_MS);
    expect(estimateLatencyMs(Array(8).fill(-200))).toBe(LATENCY_MIN_MS);
  });

  it('needs at least three taps', () => {
    expect(estimateLatencyMs([10, 20])).toBeNull();
  });

  it('accepts tap offsets well beyond the old 160 ms limit', () => {
    expect(CALIBRATION_MAX_TAP_OFFSET_MS).toBeGreaterThanOrEqual(LATENCY_MAX_MS);
    expect(LATENCY_MAX_MS).toBeGreaterThanOrEqual(400);
  });
});

describe('detectLatencyIssue', () => {
  it('flags every note being far late as latency, not playing', () => {
    const issue = detectLatencyIssue(summaryOf([250, 245, 262, 238, 255, 249, 251, 247]));
    expect(issue?.direction).toBe('late');
    expect(issue?.meanMs).toBeGreaterThan(200);
    expect(issue?.message).toMatch(/latency/i);
  });

  it('flags a large consistent early offset too', () => {
    expect(detectLatencyIssue(summaryOf([-90, -95, -88, -92, -91, -89, -93, -90]))?.direction).toBe('early');
  });

  it('ignores normal musical rushing and dragging', () => {
    expect(detectLatencyIssue(summaryOf([12, 15, 10, 14, 11, 13, 12, 16]))).toBeNull();
    expect(detectLatencyIssue(summaryOf([-20, -25, -18, -22, -21, -19, -24, -23]))).toBeNull();
  });

  it('needs enough notes', () => {
    expect(detectLatencyIssue(summaryOf([250, 250, 250]))).toBeNull();
  });
});
