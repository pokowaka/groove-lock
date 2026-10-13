import { describe, expect, it } from 'vitest';
import {
  appendRound,
  type CoachProgress,
  entryLevelFor,
  HISTORY_LIMIT,
  isMastered,
  loadCoachProgress,
  loadHistory,
  localDay,
  masteredDrills,
  type RoundRecord,
  saveCoachProgress,
  saveHistory,
  summarizeDays,
  updateDrillProgress,
} from '../src/groove/history';

class FakeStorage {
  private data = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function record(at: Date, overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    at: at.toISOString(),
    bpm: 90,
    groovePattern: 'uniform',
    subdivision: 1,
    pocketCenterMs: 0,
    pocketWindowMs: 16,
    drillId: null,
    drillLevel: null,
    hitCount: 32,
    expectedCount: 32,
    inPocketPct: 80,
    meanFeelDeltaMs: 2,
    sigmaMs: 8,
    stars: 2,
    ...overrides,
  };
}

describe('localDay', () => {
  it('formats the local calendar day', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('round history', () => {
  it('appends and caps to the most recent records', () => {
    let history: RoundRecord[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      history = appendRound(history, record(new Date(2026, 0, 1, 0, 0, i), { bpm: i }));
    }
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[history.length - 1].bpm).toBe(HISTORY_LIMIT + 4);
  });

  it('round-trips through storage and drops invalid entries', () => {
    const storage = new FakeStorage();
    saveHistory([record(new Date(2026, 0, 1))], storage);
    expect(loadHistory(storage)).toHaveLength(1);

    storage.setItem('groovelock.history.v1', JSON.stringify([{ nope: true }, record(new Date())]));
    expect(loadHistory(storage)).toHaveLength(1);

    storage.setItem('groovelock.history.v1', '{not json');
    expect(loadHistory(storage)).toEqual([]);
  });
});

describe('summarizeDays', () => {
  it('groups rounds by local day, newest first', () => {
    const now = new Date(2026, 2, 10, 20, 0);
    const history = [
      record(new Date(2026, 2, 8, 10, 0), { inPocketPct: 60, stars: 1 }),
      record(new Date(2026, 2, 10, 9, 0), { inPocketPct: 70, stars: 2 }),
      record(new Date(2026, 2, 10, 19, 0), { inPocketPct: 90, stars: 3 }),
    ];
    const days = summarizeDays(history, now, 3);
    expect(days.map((d) => d.day)).toEqual(['2026-03-10', '2026-03-09', '2026-03-08']);
    expect(days[0]).toEqual({ day: '2026-03-10', rounds: 2, avgPocketPct: 80, threeStarRounds: 1 });
    expect(days[1]).toEqual({ day: '2026-03-09', rounds: 0, avgPocketPct: null, threeStarRounds: 0 });
    expect(days[2].avgPocketPct).toBe(60);
  });

  it('ignores drill rounds when averaging your groove', () => {
    const now = new Date(2026, 2, 10, 20, 0);
    const days = summarizeDays(
      [record(now, { inPocketPct: 50 }), record(now, { inPocketPct: 100, drillId: 'lay-it-back', drillLevel: 0 })],
      now,
      1,
    );
    expect(days[0].rounds).toBe(1);
    expect(days[0].avgPocketPct).toBe(50);
  });
});

describe('drill progress', () => {
  const day1 = new Date(2026, 2, 10, 20, 0);
  const day1Later = new Date(2026, 2, 10, 22, 0);
  const day2 = new Date(2026, 2, 11, 9, 0);

  it('remembers the best level reached', () => {
    let p: CoachProgress = {};
    p = updateDrillProgress(p, 'spot-fix', { levelReached: 2, levelCount: 5, completed: false, now: day1 });
    p = updateDrillProgress(p, 'spot-fix', { levelReached: 1, levelCount: 5, completed: false, now: day1 });
    expect(p['spot-fix']?.bestLevel).toBe(2);
    expect(p['spot-fix']?.levelCount).toBe(5);
    expect(p['spot-fix']?.lastPlayedAt).toBe(day1.toISOString());
  });

  it('is mastered after completing it on two different days', () => {
    let p: CoachProgress = {};
    p = updateDrillProgress(p, 'ghost-drummer', { levelReached: 6, levelCount: 7, completed: true, now: day1 });
    p = updateDrillProgress(p, 'ghost-drummer', { levelReached: 6, levelCount: 7, completed: true, now: day1Later });
    expect(isMastered(p, 'ghost-drummer')).toBe(false);
    p = updateDrillProgress(p, 'ghost-drummer', { levelReached: 6, levelCount: 7, completed: true, now: day2 });
    expect(isMastered(p, 'ghost-drummer')).toBe(true);
    expect(masteredDrills(p)).toEqual(new Set(['ghost-drummer']));
  });

  it('starts one level below your best so the first round is a win', () => {
    let p: CoachProgress = {};
    expect(entryLevelFor(p, 'on-top', 6)).toBe(0);
    p = updateDrillProgress(p, 'on-top', { levelReached: 3, levelCount: 6, completed: false, now: day1 });
    expect(entryLevelFor(p, 'on-top', 6)).toBe(2);
    p = updateDrillProgress(p, 'on-top', { levelReached: 5, levelCount: 6, completed: true, now: day1 });
    expect(entryLevelFor(p, 'on-top', 6)).toBe(4);
    expect(entryLevelFor(p, 'on-top', 3)).toBe(1);
  });

  it('round-trips through storage and tolerates garbage', () => {
    const storage = new FakeStorage();
    const p = updateDrillProgress({}, 'lay-it-back', { levelReached: 1, levelCount: 6, completed: false, now: day1 });
    saveCoachProgress(p, storage);
    expect(loadCoachProgress(storage)).toEqual(p);
    storage.setItem('groovelock.coach.v1', JSON.stringify({ drills: { 'lay-it-back': { bestLevel: 'x' }, bogus: {} } }));
    expect(loadCoachProgress(storage)).toEqual({});
  });
});
