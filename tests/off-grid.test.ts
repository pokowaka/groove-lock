import { describe, expect, it } from 'vitest';
import {
  displaceRhythm,
  groupsRhythm,
  regridRhythm,
  spotRhythm,
  strangeRhythm,
} from '../src/groove/off-grid';
import { parseRhythm, resolveRhythmBarSteps } from '../src/groove/rhythm';

const notePositions = (bars: readonly string[]): number[] =>
  [...bars.join('')].flatMap((c, i) => (c === 'x' || c === 'o' ? [i] : []));

describe('Odd Spot rhythms', () => {
  it('puts one note on a named 16th spot', () => {
    expect(spotRhythm([['2a']]).bars).toEqual(['.......x........']);
    expect(spotRhythm([['1e', '3&']]).bars).toEqual(['.x........x.....']);
  });

  it('builds a moving spot over several bars', () => {
    expect(spotRhythm([['1a'], ['3e']]).bars).toEqual(['...x............', '.........x......']);
  });

  it('supports triplet spots', () => {
    const r = spotRhythm([['2let']], 3);
    expect(r.subdivision).toBe(3);
    expect(r.bars).toEqual(['.....x......']);
  });

  it('rejects spots that do not exist', () => {
    expect(() => spotRhythm([['5e']])).toThrow(/spot/);
    expect(() => spotRhythm([['2x']])).toThrow(/spot/);
    expect(() => spotRhythm([['2trip']])).toThrow(/spot/);
  });
});

describe('regrid and displacement', () => {
  it('rewrites a rhythm on a finer grid without changing it', () => {
    const r = regridRhythm({ subdivision: 2, bars: ['x--o x-x.'] }, 4);
    expect(r.bars).toEqual(['x-----o-x---x-..']);
    const before = resolveRhythmBarSteps({ subdivision: 2, bars: ['x--ox-x.'] }, 0).filter((s) => s.isTargetActive);
    const after = resolveRhythmBarSteps(r, 0).filter((s) => s.isTargetActive);
    expect(after.map((s) => s.lengthBeats)).toEqual(before.map((s) => s.lengthBeats));
  });

  it('refuses grids that do not divide evenly', () => {
    expect(() => regridRhythm({ subdivision: 2, bars: ['xxxxxxxx'] }, 3)).toThrow(/grid/);
  });

  it('shifts a rhythm later by whole steps, wrapping across bars', () => {
    expect(displaceRhythm({ subdivision: 4, bars: ['x...x...x...x...'] }, 2).bars).toEqual([
      '..x...x...x...x.',
    ]);
    expect(displaceRhythm({ subdivision: 1, bars: ['x...', '..x-'] }, 1).bars).toEqual(['-x..', '...x']);
  });
});

describe('Groups Over 4', () => {
  it('fits 3+3+3+3+4 into one 16th bar', () => {
    expect(groupsRhythm([3, 3, 3, 3, 4], 4).bars).toEqual(['x--x--x--x--x---']);
  });

  it('runs a group of 3 until it lines up with the bar again', () => {
    const r = groupsRhythm([3], 4);
    expect(r.bars).toHaveLength(3);
    expect(notePositions(r.bars)).toEqual(Array.from({ length: 16 }, (_, i) => i * 3));
  });

  it('makes quarter-note triplets from groups of 2 on a triplet grid', () => {
    expect(groupsRhythm([2], 3).bars).toEqual(['x-x-x-x-x-x-']);
  });

  it('needs 5 bars for groups of 5', () => {
    expect(groupsRhythm([5], 4).bars).toHaveLength(5);
  });
});

describe('Strange Rhythms', () => {
  it('is repeatable for a seed and different across seeds', () => {
    const a = strangeRhythm(42, { notes: 3 });
    expect(strangeRhythm(42, { notes: 3 })).toEqual(a);
    const others = [1, 2, 3, 4, 5].map((seed) => strangeRhythm(seed, { notes: 3 }).bars[0]);
    expect(new Set(others).size).toBeGreaterThan(2);
  });

  it('is a valid one-bar rhythm with the requested number of notes, mostly off the beat', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const notes = 1 + (seed % 5);
      const r = strangeRhythm(seed, { notes });
      expect(() => parseRhythm(r)).not.toThrow();
      const pos = notePositions(r.bars);
      expect(pos).toHaveLength(notes);
      const offBeat = pos.filter((p) => p % 4 !== 0).length;
      expect(offBeat).toBeGreaterThanOrEqual(Math.ceil(notes / 2));
      for (let i = 1; i < pos.length; i++) {
        expect(pos[i] - pos[i - 1]).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
