import { describe, expect, it } from 'vitest';
import {
  aggregateByStep,
  computeGrooveMeter,
  formatStepName,
  judgeHit,
  type RoundHit,
  StreakTracker,
  summarizeRound,
} from '../src/groove/scoring';
import { computeTapTempoBpm } from '../src/groove/tap-tempo';

function hit(
  feelDeltaMs: number,
  overrides: Partial<RoundHit> = {},
  pocketWindowMs = 16,
): RoundHit {
  return {
    stepKey: '0:0',
    stepName: 'beat 1',
    offsetMs: feelDeltaMs,
    feelDeltaMs,
    inPocket: Math.abs(feelDeltaMs) <= pocketWindowMs,
    noteMatched: true,
    ...overrides,
  };
}

describe('judgeHit', () => {
  it('grades within 40% of the window as locked', () => {
    expect(judgeHit(0, 16)).toBe('locked');
    expect(judgeHit(6.4, 16)).toBe('locked');
    expect(judgeHit(-6.4, 16)).toBe('locked');
  });

  it('grades inside the window as pocket', () => {
    expect(judgeHit(7, 16)).toBe('pocket');
    expect(judgeHit(-16, 16)).toBe('pocket');
  });

  it('grades outside the window by direction', () => {
    expect(judgeHit(-16.1, 16)).toBe('rushed');
    expect(judgeHit(30, 16)).toBe('dragged');
  });
});

describe('computeGrooveMeter', () => {
  it('returns an empty reading until enough hits are collected', () => {
    const reading = computeGrooveMeter([1, 2, 3]);
    expect(reading.sigmaMs).toBeNull();
    expect(reading.tier).toBeNull();
    expect(reading.fill).toBe(0);
  });

  it('rates a perfectly steady player as machine with a full meter', () => {
    const reading = computeGrooveMeter([12, 12, 12, 12, 12, 12]);
    expect(reading.sigmaMs).toBe(0);
    expect(reading.tier).toBe('machine');
    expect(reading.fill).toBe(1);
  });

  it('ignores a constant offset: laid-back but steady is still tight', () => {
    const steadyBehind = [20, 22, 18, 21, 19, 20, 22, 18];
    const reading = computeGrooveMeter(steadyBehind);
    expect(reading.tier).toBe('machine');
  });

  it('rates large spread as wobbly', () => {
    const reading = computeGrooveMeter([-40, 40, -35, 35, -30, 30]);
    expect(reading.tier).toBe('wobbly');
    expect(reading.fill).toBe(0);
  });

  it('only considers the most recent window of hits', () => {
    const oldChaos = [-50, 50, -50, 50];
    const recentSteady = Array.from({ length: 16 }, () => 3);
    const reading = computeGrooveMeter([...oldChaos, ...recentSteady], 16);
    expect(reading.sigmaMs).toBe(0);
  });
});

describe('StreakTracker', () => {
  it('counts consecutive successes and remembers the best', () => {
    const streak = new StreakTracker();
    [true, true, true, false, true].forEach((ok) => streak.record(ok));
    expect(streak.current).toBe(1);
    expect(streak.best).toBe(3);
  });

  it('reset clears both counters', () => {
    const streak = new StreakTracker();
    streak.record(true);
    streak.reset();
    expect(streak.current).toBe(0);
    expect(streak.best).toBe(0);
  });
});

describe('formatStepName', () => {
  it('names downbeats and subdivisions musically', () => {
    expect(formatStepName(0, 0, 1)).toBe('beat 1');
    expect(formatStepName(3, 1, 2)).toBe('4-&');
    expect(formatStepName(1, 3, 4)).toBe('2-a');
    expect(formatStepName(2, 1, 3)).toBe('3-trip');
  });
});

describe('aggregateByStep', () => {
  it('averages feel deltas per step', () => {
    const agg = aggregateByStep([
      hit(10, { stepKey: '3:1', stepName: '4-&' }),
      hit(20, { stepKey: '3:1', stepName: '4-&' }),
      hit(-4, { stepKey: '0:0' }),
    ]);
    expect(agg.get('3:1')).toEqual({ stepName: '4-&', count: 2, meanFeelDeltaMs: 15 });
    expect(agg.get('0:0')?.count).toBe(1);
  });
});

describe('summarizeRound', () => {
  it('awards three stars for a tight, complete round', () => {
    const hits = Array.from({ length: 32 }, (_, i) => hit(i % 2 === 0 ? 2 : -2));
    const summary = summarizeRound(hits, { pocketWindowMs: 16, expectedTargetCount: 32 });
    expect(summary.stars).toBe(3);
    expect(summary.inPocketPct).toBe(100);
    expect(summary.tip).toMatch(/solid/i);
  });

  it('counts missed notes against the pocket rate', () => {
    const hits = Array.from({ length: 16 }, () => hit(0));
    const summary = summarizeRound(hits, { pocketWindowMs: 16, expectedTargetCount: 32 });
    expect(summary.inPocketPct).toBe(50);
    expect(summary.stars).toBeLessThan(3);
    expect(summary.tip).toMatch(/missed/i);
  });

  it('points at the step that is consistently rushed', () => {
    const hits = [
      ...Array.from({ length: 12 }, () => hit(1)),
      ...Array.from({ length: 4 }, () =>
        hit(-14, { stepKey: '3:1', stepName: '4-&' }),
      ),
    ];
    const summary = summarizeRound(hits, { pocketWindowMs: 16, expectedTargetCount: 16 });
    expect(summary.tip).toContain('rush');
    expect(summary.tip).toContain('4-&');
    expect(summary.worstStep?.stepName).toBe('4-&');
  });

  it('reports overall dragging when every step is late', () => {
    const hits = Array.from({ length: 16 }, (_, i) =>
      hit(12, { stepKey: `${i % 4}:0`, stepName: `beat ${(i % 4) + 1}` }),
    );
    const summary = summarizeRound(hits, { pocketWindowMs: 16, expectedTargetCount: 16 });
    expect(summary.tip).toMatch(/behind/i);
  });

  it('handles an empty round without throwing', () => {
    const summary = summarizeRound([], { pocketWindowMs: 16, expectedTargetCount: 16 });
    expect(summary.stars).toBe(0);
    expect(summary.sigmaMs).toBeNull();
    expect(summary.tip).toMatch(/no notes/i);
  });
});

describe('computeTapTempoBpm', () => {
  it('needs at least two taps', () => {
    expect(computeTapTempoBpm([1000])).toBeNull();
  });

  it('averages the recent intervals', () => {
    expect(computeTapTempoBpm([0, 500, 1000, 1500])).toBe(120);
  });

  it('starts over after a long pause', () => {
    expect(computeTapTempoBpm([0, 1000, 5000, 5600])).toBe(100);
  });

  it('clamps to the supported tempo range', () => {
    expect(computeTapTempoBpm([0, 100])).toBe(200);
    expect(computeTapTempoBpm([0, 1900])).toBe(40);
  });
});
