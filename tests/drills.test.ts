import { describe, expect, it } from 'vitest';
import {
  advanceStaircase,
  buildDrillPlan,
  DRILL_SETTING_KEYS,
  type DrillSettings,
  judgeDrillRound,
  measureFocus,
  recommendDrill,
  startStaircase,
} from '../src/groove/drills';
import { type RoundHit, summarizeRound } from '../src/groove/scoring';

const W = 16;

const BASE: DrillSettings = {
  bpm: 100,
  groovePattern: 'motown-pocket',
  subdivision: 1,
  clickPlacement: 'all',
  gapBars: 0,
  pocketCenterMs: 0,
  pocketWindowMs: W,
  soundMode: 'drums',
  bassGuideMode: 'demo-first',
  roundBars: 8,
  drillMode: 'root-cycle',
  speedTrainerStep: 2,
};

function hit(feelDeltaMs: number, overrides: Partial<RoundHit> = {}): RoundHit {
  return {
    stepKey: '0:0',
    stepName: 'beat 1',
    offsetMs: feelDeltaMs,
    feelDeltaMs,
    inPocket: Math.abs(feelDeltaMs) <= W,
    noteMatched: true,
    inSilentBar: false,
    ...overrides,
  };
}

function spread(n: number, values: readonly number[], overrides: Partial<RoundHit> = {}): RoundHit[] {
  return Array.from({ length: n }, (_, i) => hit(values[i % values.length], overrides));
}

function recommend(hits: RoundHit[], expected = hits.length) {
  const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: expected });
  return recommendDrill(summary, hits, { pocketWindowMs: W, expectedTargetCount: expected });
}

describe('recommendDrill', () => {
  it('returns nothing when no notes were played', () => {
    expect(recommend([], 16)).toBeNull();
  });

  it('suggests slowing down when many notes were missed', () => {
    const rec = recommend(spread(8, [0, 2, -2]), 16);
    expect(rec?.drillId).toBe('spot-fix');
    expect(rec?.focusStep).toBeNull();
    expect(rec?.reason).toMatch(/missed/i);
  });

  it('targets the single step that is rushed', () => {
    const hits = [
      ...spread(12, [1, -1, 2]),
      ...spread(4, [-14], { stepKey: '1:1', stepName: '2-&' }),
    ];
    const rec = recommend(hits);
    expect(rec?.drillId).toBe('spot-fix');
    expect(rec?.focusStep).toEqual({ key: '1:1', name: '2-&' });
    expect(rec?.reason).toContain('2-&');
  });

  it('suggests Lay It Back when rushing overall', () => {
    const rec = recommend(spread(16, [-10, -12, -11, -9]));
    expect(rec?.drillId).toBe('lay-it-back');
  });

  it('suggests On Top when dragging overall', () => {
    const rec = recommend(spread(16, [10, 12, 11, 9]));
    expect(rec?.drillId).toBe('on-top');
  });

  it('hints at calibration when a bias is suspiciously constant', () => {
    const rec = recommend(spread(16, [12, 12.5, 11.5]));
    expect(rec?.reason).toMatch(/latency/i);
  });

  it('suggests Steady Quarters when centered but unsteady', () => {
    const rec = recommend(spread(16, [-14, 14, -12, 12]));
    expect(rec?.drillId).toBe('steady-quarters');
  });

  it('suggests Ghost Drummer when timing falls apart in silent bars', () => {
    const hits = [
      ...spread(12, [1, -1, 2]),
      ...spread(8, [1, 30, -2, 28], { inSilentBar: true }),
    ];
    const rec = recommend(hits);
    expect(rec?.drillId).toBe('ghost-drummer');
    expect(rec?.reason).toMatch(/click/i);
  });

  it('offers Ghost Drummer as a challenge when everything is solid', () => {
    const rec = recommend(spread(16, [1, -1, 2, -2]));
    expect(rec?.drillId).toBe('ghost-drummer');
    expect(rec?.reason).toMatch(/solid/i);
  });
});

describe('buildDrillPlan', () => {
  const ids = ['steady-quarters', 'lay-it-back', 'on-top', 'spot-fix', 'ghost-drummer'] as const;

  it.each(ids)('%s has several levels that each set every drill key', (id) => {
    const plan = buildDrillPlan(id, BASE, null);
    expect(plan.levels.length).toBeGreaterThanOrEqual(5);
    for (const level of plan.levels) {
      for (const key of DRILL_SETTING_KEYS) {
        expect(level.settings[key]).not.toBeUndefined();
      }
      expect(level.label.length).toBeGreaterThan(0);
    }
  });

  it.each(ids)('%s turns the reference bass and auto tempo off', (id) => {
    for (const level of buildDrillPlan(id, BASE, null).levels) {
      expect(level.settings.bassGuideMode).toBe('off');
      expect(level.settings.speedTrainerStep).toBe(0);
    }
  });

  it('starts easier than what the player just played', () => {
    const first = buildDrillPlan('spot-fix', BASE, null).levels[0].settings;
    expect(first.bpm).toBeLessThan(BASE.bpm);
    expect(first.pocketWindowMs).toBeGreaterThanOrEqual(BASE.pocketWindowMs);
  });

  it('spot fix keeps the groove and notes and climbs back past the original tempo', () => {
    const plan = buildDrillPlan('spot-fix', BASE, { key: '1:1', name: '2-&' });
    const last = plan.levels[plan.levels.length - 1].settings;
    expect(plan.levels.every((l) => l.settings.groovePattern === 'motown-pocket')).toBe(true);
    expect(plan.levels.every((l) => l.settings.drillMode === 'root-cycle')).toBe(true);
    expect(last.bpm).toBeGreaterThanOrEqual(BASE.bpm);
    expect(plan.focusStep?.name).toBe('2-&');
  });

  it('lay it back targets a laid-back feel and on top a pushed feel', () => {
    expect(buildDrillPlan('lay-it-back', BASE, null).levels.every((l) => l.settings.pocketCenterMs === 12)).toBe(true);
    expect(buildDrillPlan('on-top', BASE, null).levels.every((l) => l.settings.pocketCenterMs === -8)).toBe(true);
  });

  it('ghost drummer removes more of the click as levels rise', () => {
    const levels = buildDrillPlan('ghost-drummer', BASE, null).levels.map((l) => l.settings);
    expect(levels[0].gapBars).toBe(1);
    expect(levels[0].clickPlacement).toBe('all');
    expect(levels[levels.length - 1].clickPlacement).toBe('one-drop-1');
    expect(levels[levels.length - 1].gapBars).toBe(2);
  });

  it('never goes below a playable tempo', () => {
    const slow = { ...BASE, bpm: 50 };
    for (const id of ids) {
      for (const level of buildDrillPlan(id, slow, null).levels) {
        expect(level.settings.bpm).toBeGreaterThanOrEqual(50);
      }
    }
  });
});

describe('judgeDrillRound', () => {
  function judge(hits: RoundHit[], focusKey: string | null = null) {
    const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: hits.length });
    return judgeDrillRound(summary, hits, { pocketWindowMs: W, focusStepKey: focusKey });
  }

  it('passes a tight round', () => {
    expect(judge(spread(16, [1, -1, 3, -3]))).toBe('pass');
  });

  it('fails a round with fewer than 60% in the pocket', () => {
    expect(judge(spread(10, [0, 30]))).toBe('fail');
  });

  it('is neutral in between', () => {
    expect(judge(spread(10, [0, 0, 30]))).toBe('neutral');
  });

  it('does not pass while the focus step is still off', () => {
    const hits = [...spread(14, [0, 1, -1]), ...spread(3, [-11], { stepKey: '1:1', stepName: '2-&' })];
    expect(judge(hits, null)).toBe('pass');
    expect(judge(hits, '1:1')).toBe('neutral');
  });
});

describe('advanceStaircase', () => {
  it('levels up after two passes in a row', () => {
    let s = startStaircase();
    let r = advanceStaircase(s, 'pass', 5);
    expect(r.event).toBe('hold');
    r = advanceStaircase(r.state, 'pass', 5);
    expect(r.event).toBe('level-up');
    expect(r.state.level).toBe(1);
    s = r.state;
    expect(s.passStreak).toBe(0);
  });

  it('a neutral round breaks the streak', () => {
    let r = advanceStaircase(startStaircase(), 'pass', 5);
    r = advanceStaircase(r.state, 'neutral', 5);
    r = advanceStaircase(r.state, 'pass', 5);
    expect(r.event).toBe('hold');
    expect(r.state.level).toBe(0);
  });

  it('levels down after two fails, but never below the first level', () => {
    let r = advanceStaircase(startStaircase(2), 'fail', 5);
    r = advanceStaircase(r.state, 'fail', 5);
    expect(r.event).toBe('level-down');
    expect(r.state.level).toBe(1);
    r = advanceStaircase(startStaircase(0), 'fail', 5);
    r = advanceStaircase(r.state, 'fail', 5);
    expect(r.event).toBe('hold');
    expect(r.state.level).toBe(0);
  });

  it('completes after two passes on the top level', () => {
    let r = advanceStaircase(startStaircase(4), 'pass', 5);
    r = advanceStaircase(r.state, 'pass', 5);
    expect(r.event).toBe('complete');
    expect(r.state.level).toBe(4);
  });
});

describe('measureFocus', () => {
  it('measures the focus step average for spot fix', () => {
    const plan = buildDrillPlan('spot-fix', BASE, { key: '1:1', name: '2-&' });
    const hits = [...spread(4, [0]), ...spread(2, [-10, -6], { stepKey: '1:1', stepName: '2-&' })];
    const m = measureFocus(plan, hits);
    expect(m.label).toContain('2-&');
    expect(m.value).toBe(-8);
    expect(m.unit).toBe('ms');
  });

  it('measures spread for steady quarters and silent-bar spread for ghost drummer', () => {
    const steady = measureFocus(buildDrillPlan('steady-quarters', BASE, null), spread(4, [-2, 2]));
    expect(steady.value).toBe(2);
    const ghostHits = [...spread(4, [0]), ...spread(4, [-6, 6], { inSilentBar: true })];
    const ghost = measureFocus(buildDrillPlan('ghost-drummer', BASE, null), ghostHits);
    expect(ghost.label).toMatch(/silent/i);
    expect(ghost.value).toBe(6);
  });

  it('measures average timing vs the grid for feel drills', () => {
    const m = measureFocus(buildDrillPlan('lay-it-back', BASE, null), spread(4, [-12, -8], { offsetMs: -10 }));
    expect(m.value).toBe(-10);
  });

  it('returns null without evidence', () => {
    expect(measureFocus(buildDrillPlan('steady-quarters', BASE, null), []).value).toBeNull();
  });
});
