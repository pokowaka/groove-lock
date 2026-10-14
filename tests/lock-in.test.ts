import { describe, expect, it } from 'vitest';
import { advanceLockIn, startStaircase } from '../src/groove/drills';
import {
  goalBarsForLevel,
  isCleanBar,
  LockInTracker,
  maxBarsForGoal,
} from '../src/groove/lock-in';

const ok = { inPocket: true, noteMatched: true };

describe('isCleanBar (strict)', () => {
  it('is clean only when every note landed in the pocket on the right pitch, with nothing extra', () => {
    expect(isCleanBar({ expected: 4, hits: [ok, ok, ok, ok], strays: 0, lengths: [] })).toBe(true);
    expect(isCleanBar({ expected: 4, hits: [ok, ok, ok], strays: 0, lengths: [] })).toBe(false);
    expect(isCleanBar({ expected: 4, hits: [ok, ok, ok, { ...ok, inPocket: false }], strays: 0, lengths: [] })).toBe(false);
    expect(isCleanBar({ expected: 4, hits: [ok, ok, ok, { ...ok, noteMatched: false }], strays: 0, lengths: [] })).toBe(false);
    expect(isCleanBar({ expected: 4, hits: [ok, ok, ok, ok], strays: 1, lengths: [] })).toBe(false);
  });

  it('also needs every graded note length on time', () => {
    const hits = [ok, ok];
    expect(isCleanBar({ expected: 2, hits, strays: 0, lengths: ['on-time', 'on-time'] })).toBe(true);
    expect(isCleanBar({ expected: 2, hits, strays: 0, lengths: ['on-time', 'short'] })).toBe(false);
    expect(isCleanBar({ expected: 2, hits, strays: 0, lengths: ['long'] })).toBe(false);
  });

  it('a bar with nothing to play is never clean', () => {
    expect(isCleanBar({ expected: 0, hits: [], strays: 0, lengths: [] })).toBe(false);
  });
});

describe('LockInTracker', () => {
  it('counts clean bars in a row and resets on a miss', () => {
    const t = new LockInTracker(3, 20);
    expect(t.record(0, true)).toBe('clean');
    expect(t.record(1, false)).toBe('miss');
    expect(t.streak).toBe(0);
    expect(t.record(2, true)).toBe('clean');
    expect(t.record(3, true)).toBe('clean');
    expect(t.record(4, true)).toBe('nailed');
    expect(t.best).toBe(3);
    expect(t.nailedBars).toEqual({ from: 2, to: 4 });
    expect(t.firstBars).toEqual({ from: 0, to: 2 });
  });

  it('gives up after too many bars without nailing it', () => {
    const t = new LockInTracker(4, 6);
    const events = [0, 1, 2, 3, 4, 5].map((b) => t.record(b, b % 2 === 0));
    expect(events.at(-1)).toBe('gave-up');
    expect(t.nailedBars).toBeNull();
    expect(t.lastBars).toEqual({ from: 2, to: 5 });
  });

  it('stops counting once finished', () => {
    const t = new LockInTracker(1, 10);
    expect(t.record(0, true)).toBe('nailed');
    expect(t.record(1, false)).toBe('nailed');
    expect(t.isFinished).toBe(true);
  });
});

describe('ramping the goal', () => {
  it('asks for more clean bars as the levels rise', () => {
    expect(goalBarsForLevel(0, 9)).toBe(2);
    expect(goalBarsForLevel(4, 9)).toBe(4);
    expect(goalBarsForLevel(8, 9)).toBe(8);
    const goals = Array.from({ length: 12 }, (_, i) => goalBarsForLevel(i, 12));
    expect(goals).toEqual([...goals].sort((a, b) => a - b));
  });

  it('leaves room to warm up before giving up', () => {
    expect(maxBarsForGoal(2)).toBeGreaterThanOrEqual(12);
    expect(maxBarsForGoal(8)).toBeGreaterThan(maxBarsForGoal(4));
  });
});

describe('advanceLockIn', () => {
  it('levels up every time you nail it, completing on the top level', () => {
    expect(advanceLockIn(startStaircase(0), 'nailed', 5)).toEqual({ state: startStaircase(1), event: 'level-up' });
    expect(advanceLockIn(startStaircase(4), 'nailed', 5).event).toBe('complete');
  });

  it('steps back after giving up twice in a row', () => {
    const once = advanceLockIn(startStaircase(2), 'gave-up', 5);
    expect(once.event).toBe('hold');
    expect(advanceLockIn(once.state, 'gave-up', 5)).toEqual({ state: startStaircase(1), event: 'level-down' });
  });
});
