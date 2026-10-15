import { describe, expect, it } from 'vitest';
import { parseRhythm } from '../src/groove/rhythm';
import {
  breakSection,
  chooseFork,
  currentSection,
  FORK_EVERY,
  goalBarsForDepth,
  loadRoadProgress,
  MAX_HEARTS,
  nailSection,
  recordRun,
  REGIONS,
  type RunState,
  saveRoadProgress,
  startRun,
} from '../src/groove/road';

const nailTimes = (s: RunState, n: number): RunState => {
  let state = s;
  for (let i = 0; i < n; i++) state = nailSection(state);
  return state;
};

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe('regions', () => {
  it('have valid rhythm decks that get busier', () => {
    for (const region of REGIONS) {
      expect(region.deck.length).toBeGreaterThanOrEqual(5);
      for (const card of region.deck) {
        expect(() => parseRhythm(card.rhythm)).not.toThrow();
        expect(card.label.length).toBeGreaterThan(3);
      }
    }
    expect(REGIONS[0].deck[0].rhythm.bars[0].replace(/[-\s]/g, '')).toBe('xxxx');
  });
});

describe('a run', () => {
  it('starts at the camp, plain, with full hearts and a demo of the first rhythm', () => {
    const s = startRun('pulse-plains');
    expect(s.hearts).toBe(MAX_HEARTS);
    const sec = currentSection(s);
    expect(sec.kind).toBe('groove');
    expect(sec.band).toBe(0);
    expect(sec.goalBars).toBe(2);
    expect(sec.demoFirst).toBe(true);
  });

  it('alternates speeding up and changing the rhythm while you nail it', () => {
    const s0 = startRun('pulse-plains');
    const s1 = nailSection(s0);
    expect(s1.bpm).toBe(s0.bpm + 4);
    expect(s1.deckIndex).toBe(0);
    expect(currentSection(s1).demoFirst).toBe(false);
    const s2 = nailSection(s1);
    expect(s2.deckIndex).toBe(1);
    expect(currentSection(s2).demoFirst).toBe(true);
    expect(s2.band).toBe(2);
  });

  it('asks for more clean bars the further you get', () => {
    expect(goalBarsForDepth(0)).toBe(2);
    expect(goalBarsForDepth(4)).toBe(4);
    expect(goalBarsForDepth(12)).toBe(8);
  });

  it('a broken section costs a heart, slows down, drops a band layer, and repeats the rhythm', () => {
    const s = nailTimes(startRun('pulse-plains'), 3);
    const b = breakSection(s);
    expect(b.hearts).toBe(MAX_HEARTS - 1);
    expect(b.bpm).toBe(s.bpm - 6);
    expect(b.band).toBe(s.band - 1);
    expect(b.deckIndex).toBe(s.deckIndex);
    expect(b.over).toBe(false);
    expect(breakSection(breakSection(b)).over).toBe(true);
  });

  it('never drops below a playable tempo', () => {
    let s = startRun('pulse-plains');
    for (let i = 0; i < 2; i++) s = breakSection({ ...s, bpm: 52 });
    expect(s.bpm).toBeGreaterThanOrEqual(50);
  });

  it('reaches a fork after a few nailed sections, chosen with E (left) or A (right)', () => {
    const s = nailTimes(startRun('pulse-plains'), FORK_EVERY);
    const fork = currentSection(s);
    expect(fork.kind).toBe('fork');
    expect(fork.fork?.left).toMatchObject({ road: 'fast', note: 'E' });
    expect(fork.fork?.right).toMatchObject({ road: 'ghost', note: 'A' });

    const fast = chooseFork(s, 'left');
    expect(fast.road).toBe('fast');
    expect(fast.bpm).toBe(s.bpm + 12);
    expect(currentSection(fast).kind).toBe('groove');

    const ghost = chooseFork(s, 'right');
    const g1 = currentSection(ghost);
    expect(g1.clickPlacement).toBe('backbeat-2-4');
    const g2 = currentSection(nailSection(ghost));
    expect(g2.clickPlacement).toBe('one-drop-1');
    const g3 = currentSection(nailSection(nailSection(ghost)));
    expect(g3.gapBars).toBe(1);
    const back = nailTimes(ghost, 3);
    expect(back.road).toBe('main');
    expect(currentSection(back).clickPlacement).toBe('beats');

    const straight = chooseFork(s, null);
    expect(straight.road).toBe('main');
    expect(straight.bpm).toBe(s.bpm);
  });

  it('moves on to the next region at the end of the deck, and keeps going after the last one', () => {
    let s = startRun('pulse-plains');
    for (let i = 0; i < 60 && s.region === 'pulse-plains'; i++) {
      s = currentSection(s).kind === 'fork' ? chooseFork(s, null) : nailSection(s);
    }
    expect(s.region).toBe('syncopation-city');
    expect(s.regionsReached).toContain('syncopation-city');
    expect(s.deckIndex).toBe(0);
    for (let i = 0; i < 80; i++) {
      s = currentSection(s).kind === 'fork' ? chooseFork(s, null) : nailSection(s);
    }
    expect(s.region).toBe('syncopation-city');
    expect(s.over).toBe(false);
    expect(s.band).toBe(5);
  });
});

describe('road progress', () => {
  it('unlocks camps for regions reached and keeps the best run', () => {
    const storage = new MemoryStorage();
    let progress = loadRoadProgress(storage);
    expect(progress.camps).toEqual(['pulse-plains']);
    const run: RunState = { ...startRun('pulse-plains'), nailed: 9, topBpm: 96, regionsReached: ['pulse-plains', 'syncopation-city'] };
    progress = recordRun(progress, run);
    saveRoadProgress(progress, storage);
    const reloaded = loadRoadProgress(storage);
    expect(reloaded.camps).toEqual(['pulse-plains', 'syncopation-city']);
    expect(reloaded.bestNailed).toBe(9);
    expect(reloaded.topBpm).toBe(96);
    expect(reloaded.runs).toBe(1);
    const worse = recordRun(reloaded, { ...startRun('pulse-plains'), nailed: 2, topBpm: 70 });
    expect(worse.bestNailed).toBe(9);
    expect(worse.runs).toBe(2);
  });

  it('ignores corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('groovelock.road.v1', '{"camps":["nowhere"],"bestNailed":"x"}');
    expect(loadRoadProgress(storage)).toEqual({ camps: ['pulse-plains'], bestNailed: 0, topBpm: 0, runs: 0 });
  });
});
