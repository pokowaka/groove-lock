import { describe, expect, it } from 'vitest';
import {
  advanceStaircase,
  buildDrillPlan,
  DRILL_SETTING_KEYS,
  type DrillSettings,
  judgeDrillRound,
  judgeNoteLengthRound,
  measureFocus,
  recommendDrill,
  startStaircase,
} from '../src/groove/drills';
import { summarizeReleases } from '../src/groove/release-grading';
import { parseRhythm, type Rhythm } from '../src/groove/rhythm';
import { type RoundHit, summarizeRound } from '../src/groove/scoring';

const W = 16;

const BASE: DrillSettings = {
  bpm: 100,
  groovePattern: 'motown-pocket',
  customRhythm: null,
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

  it('moves the challenge Off the Grid once Ghost Drummer is mastered', () => {
    const hits = spread(16, [1, -1, 2, -2]);
    const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: 16 });
    const rec = recommendDrill(summary, hits, {
      pocketWindowMs: W,
      expectedTargetCount: 16,
      mastered: new Set(['ghost-drummer']),
    });
    expect(rec?.drillId).toBe('odd-spot');
  });

  it('does not offer a challenge drill you have already mastered', () => {
    const hits = spread(16, [1, -1, 2, -2]);
    const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: 16 });
    const rec = recommendDrill(summary, hits, {
      pocketWindowMs: W,
      expectedTargetCount: 16,
      mastered: new Set(['ghost-drummer', 'odd-spot']),
    });
    expect(rec).toBeNull();
  });

  it('still prescribes a fix for a real problem even if that drill is mastered', () => {
    const hits = spread(16, [-10, -12, -11, -9]);
    const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: 16 });
    const rec = recommendDrill(summary, hits, {
      pocketWindowMs: W,
      expectedTargetCount: 16,
      mastered: new Set(['lay-it-back']),
    });
    expect(rec?.drillId).toBe('lay-it-back');
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

describe('Off the Grid drills', () => {
  const offGrid = ['odd-spot', 'displacement', 'groups-over-4', 'strange-rhythms'] as const;
  const notes = (r: Rhythm | null): number[] =>
    [...(r?.bars.join('') ?? '')].flatMap((c, i) => (c === 'x' || c === 'o' ? [i] : []));

  it.each(offGrid)('%s plays its own rhythms against a plain beat click', (id) => {
    const plan = buildDrillPlan(id, BASE, null);
    expect(plan.levels.length).toBeGreaterThanOrEqual(6);
    for (const level of plan.levels) {
      for (const key of DRILL_SETTING_KEYS) {
        expect(level.settings[key]).not.toBeUndefined();
      }
      const rhythm = level.settings.customRhythm;
      expect(rhythm).not.toBeNull();
      expect(() => parseRhythm(rhythm as Rhythm)).not.toThrow();
      expect(level.settings.clickPlacement).toBe('beats');
      expect(level.settings.gapBars).toBe(0);
      expect(level.settings.pocketCenterMs).toBe(0);
      expect(level.settings.drillMode).toBe('free');
      expect(level.settings.speedTrainerStep).toBe(0);
      expect(level.settings.roundBars).toBe(8);
    }
  });

  it('odd spot starts on the & and works up to the e, two spots, a moving spot and triplets', () => {
    const levels = buildDrillPlan('odd-spot', BASE, null).levels.map((l) => l.settings.customRhythm as Rhythm);
    expect(levels[0].bars).toEqual(['......x.........']);
    expect(levels.some((r) => r.bars.length === 1 && notes(r).length === 1 && notes(r)[0] % 4 === 1)).toBe(true);
    expect(levels.some((r) => notes(r).length === 2 && r.bars.length === 1)).toBe(true);
    expect(levels.some((r) => r.bars.length >= 4)).toBe(true);
    expect(levels.some((r) => r.subdivision === 3)).toBe(true);
  });

  it('displacement shifts a plain quarter pulse first', () => {
    const first = buildDrillPlan('displacement', BASE, null).levels[0].settings.customRhythm as Rhythm;
    expect(first.bars).toEqual(['..x-..x-..x-..x-']);
  });

  it('groups over 4 includes groups that cross the bar line', () => {
    const levels = buildDrillPlan('groups-over-4', BASE, null).levels.map((l) => l.settings.customRhythm as Rhythm);
    expect(levels.some((r) => r.bars.length === 3)).toBe(true);
    expect(levels.some((r) => r.bars.length === 5)).toBe(true);
  });

  it('strange rhythms are heard first, then echoed, getting busier', () => {
    const levels = buildDrillPlan('strange-rhythms', BASE, null).levels;
    expect(levels.every((l) => l.settings.bassGuideMode === 'call-response-1-1')).toBe(true);
    const rhythms = levels.map((l) => l.settings.customRhythm as Rhythm);
    expect(rhythms.every((r) => r.bars.length === 1)).toBe(true);
    const counts = rhythms.map((r) => notes(r).length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(new Set(rhythms.map((r) => r.bars[0])).size).toBe(rhythms.length);
  });

  it('keeps a playable tempo and climbs past the start', () => {
    for (const id of offGrid) {
      const levels = buildDrillPlan(id, { ...BASE, bpm: 50 }, null).levels;
      expect(levels.every((l) => l.settings.bpm >= 50)).toBe(true);
      const fast = buildDrillPlan(id, BASE, null).levels;
      expect(fast[fast.length - 1].settings.bpm).toBeGreaterThan(fast[0].settings.bpm);
    }
  });
});

describe('Note Length drill', () => {
  it('writes every level with graded lengths and works from simple to mixed lengths', () => {
    const levels = buildDrillPlan('note-length', BASE, null).levels;
    expect(levels.length).toBeGreaterThanOrEqual(6);
    for (const level of levels) {
      expect(level.settings.customRhythm?.gradeLengths).toBe(true);
      expect(level.settings.clickPlacement).toBe('beats');
    }
    expect(levels.some((l) => (l.settings.customRhythm?.bars.length ?? 0) >= 2)).toBe(true);
  });

  const roundOf = (n: number) => summarizeRound(spread(n, [1, -2, 3, -1]), { pocketWindowMs: W, expectedTargetCount: n });
  const releases = (onTime: number, short: number) =>
    summarizeReleases([
      ...Array.from({ length: onTime }, () => ({ stepKey: '0:0', stepName: '1', deltaMs: 5, judgment: 'on-time' as const })),
      ...Array.from({ length: short }, () => ({ stepKey: '0:0', stepName: '1', deltaMs: -60, judgment: 'short' as const })),
    ]);

  it('says in words when to let go, plays the bar first, and clicks the let-go point before taking it away', () => {
    const levels = buildDrillPlan('note-length', BASE, null).levels;
    for (const level of levels) {
      expect(level.hint?.length ?? 0).toBeGreaterThan(10);
      expect(level.settings.bassGuideMode).toBe('demo-first');
    }
    const marked = levels.findIndex((l) => l.settings.customRhythm?.markReleases);
    expect(marked).toBeGreaterThan(0);
    const next = levels[marked + 1].settings.customRhythm;
    expect(next?.bars).toEqual(levels[marked].settings.customRhythm?.bars);
    expect(next?.markReleases).toBeFalsy();
  });

  it('passes only when the notes start and end on time', () => {
    expect(judgeNoteLengthRound(roundOf(16), releases(14, 2), 16)).toBe('pass');
    expect(judgeNoteLengthRound(roundOf(16), releases(6, 10), 16)).toBe('fail');
    expect(judgeNoteLengthRound(roundOf(16), releases(10, 6), 16)).toBe('neutral');
  });

  it('cannot judge lengths it did not hear', () => {
    expect(judgeNoteLengthRound(roundOf(16), releases(2, 0), 16)).toBe('neutral');
  });

  it('is recommended when note lengths are off but timing is fine', () => {
    const hits = spread(16, [1, -1, 2, -2]);
    const summary = summarizeRound(hits, { pocketWindowMs: W, expectedTargetCount: 16 });
    const rec = recommendDrill(summary, hits, {
      pocketWindowMs: W,
      expectedTargetCount: 16,
      releases: releases(4, 10),
    });
    expect(rec?.drillId).toBe('note-length');
    expect(rec?.reason).toMatch(/short/);
  });

  it('measures note lengths on time as its focus', () => {
    const plan = buildDrillPlan('note-length', BASE, null);
    const m = measureFocus(plan, spread(8, [0]), [
      { stepKey: '0:0', stepName: '1', deltaMs: 5, judgment: 'on-time' },
      { stepKey: '0:0', stepName: '1', deltaMs: -50, judgment: 'short' },
    ]);
    expect(m).toEqual({ label: 'Note lengths on time', value: 50, unit: '%' });
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
