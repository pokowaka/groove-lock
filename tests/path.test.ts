import { describe, expect, it } from 'vitest';
import { DRILL_TITLES, type DrillId } from '../src/groove/drills';
import type { CoachProgress, DrillProgress } from '../src/groove/history';
import { nextUp, stageState, TIME_PATH } from '../src/groove/path';

const completedOn = (...days: string[]): DrillProgress => ({
  bestLevel: 5,
  levelCount: 6,
  completionDays: days,
  lastPlayedAt: null,
});
const once = completedOn('2026-10-01');
const mastered = completedOn('2026-10-01', '2026-10-02');
const stage = (id: string) => {
  const s = TIME_PATH.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};

describe('the Time Path', () => {
  it('lists every drill except Spot Fix exactly once (Spot Fix needs a diagnosed trouble spot)', () => {
    const ids = TIME_PATH.flatMap((s) => s.items.flatMap((i) => (i.drillId ? [i.drillId] : [])));
    const expected = (Object.keys(DRILL_TITLES) as DrillId[]).filter((id) => id !== 'spot-fix');
    expect([...ids].sort()).toEqual([...expected].sort());
  });

  it('only refers to earlier stages as prerequisites', () => {
    TIME_PATH.forEach((s, i) => {
      for (const dep of s.after) {
        expect(TIME_PATH.findIndex((x) => x.id === dep)).toBeLessThan(i);
      }
    });
  });

  it('starts with Steady Quarters', () => {
    expect(nextUp({})).toEqual({ stageId: 'pulse', drillId: 'steady-quarters' });
  });

  it('moves on once a drill is completed, skipping stages with nothing to play yet', () => {
    expect(nextUp({ 'steady-quarters': once })?.drillId).toBe('ghost-drummer');
    expect(nextUp({ 'steady-quarters': once, 'ghost-drummer': once })?.drillId).toBe('note-length');
    expect(
      nextUp({ 'steady-quarters': once, 'ghost-drummer': once, 'note-length': once })?.drillId,
    ).toBe('odd-spot');
  });

  it('comes back for mastery (a second day) when everything open is completed once', () => {
    const progress: CoachProgress = {};
    for (const s of TIME_PATH) {
      for (const i of s.items) {
        if (i.drillId) progress[i.drillId] = once;
      }
    }
    expect(nextUp(progress)?.drillId).toBe('steady-quarters');
    for (const id of Object.keys(progress) as DrillId[]) progress[id] = mastered;
    expect(nextUp(progress)).toBeNull();
  });

  it('describes each stage', () => {
    expect(stageState(stage('pulse'), {})).toBe('open');
    expect(stageState(stage('subdivision'), {})).toBe('soon');
    expect(stageState(stage('off-grid'), {})).toBe('later');
    expect(stageState(stage('pulse'), { 'steady-quarters': once })).toBe('completed');
    expect(stageState(stage('pulse'), { 'steady-quarters': mastered })).toBe('mastered');
    const ready = { 'steady-quarters': once, 'ghost-drummer': once, 'note-length': once };
    expect(stageState(stage('off-grid'), ready)).toBe('open');
    expect(stageState(stage('off-grid'), { ...ready, 'odd-spot': completedOn() })).toBe('started');
  });
});
