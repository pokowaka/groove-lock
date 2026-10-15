import { describe, expect, it } from 'vitest';
import { bandBeatEvents, BAND_LEVEL_NAMES, MAX_BAND_LEVEL } from '../src/audio/band';
import type { ClickPlacementMode } from '../src/groove/patterns';

const base: {
  level: number;
  beatInBar: number;
  beatsPerBar: number;
  phraseBar: number;
  placement: ClickPlacementMode;
  silent: boolean;
  fill: boolean;
  crash: boolean;
} = {
  level: 0,
  beatInBar: 0,
  beatsPerBar: 4,
  phraseBar: 0,
  placement: 'all',
  silent: false,
  fill: false,
  crash: false,
};
const voices = (opts: Partial<typeof base>): string[] =>
  bandBeatEvents({ ...base, ...opts }).map((e) => e.voice);

describe('band arrangement', () => {
  it('starts as a plain click, accented on the 1', () => {
    const one = bandBeatEvents({ ...base, beatInBar: 0 });
    const two = bandBeatEvents({ ...base, beatInBar: 1 });
    expect(one).toEqual([{ voice: 'click', offsetBeats: 0, level: 1, click: 'downbeat' }]);
    expect(two[0].click).toBe('quarter');
  });

  it('adds a layer per level: backbeat, hi-hats, percussion, keys, then a hook', () => {
    expect(voices({ level: 1, beatInBar: 0 })).toContain('kick');
    expect(voices({ level: 1, beatInBar: 1 })).toContain('snare');
    expect(voices({ level: 1, beatInBar: 1 })).not.toContain('click');
    expect(voices({ level: 2, beatInBar: 0 }).filter((v) => v === 'hihat').length).toBe(2);
    expect(voices({ level: 3, beatInBar: 1 })).toEqual(expect.arrayContaining(['shaker', 'tambourine']));
    expect(voices({ level: 4, beatInBar: 1 })).toContain('keys');
    const hook = [0, 1].flatMap((phraseBar) =>
      [0, 1, 2, 3].flatMap((beatInBar) => voices({ level: 5, beatInBar, phraseBar })),
    );
    expect(hook).toContain('lead');
    expect(MAX_BAND_LEVEL).toBe(5);
    expect(BAND_LEVEL_NAMES).toHaveLength(MAX_BAND_LEVEL + 1);
  });

  it('keeps every event inside its beat', () => {
    for (let level = 0; level <= MAX_BAND_LEVEL; level++) {
      for (let beatInBar = 0; beatInBar < 4; beatInBar++) {
        for (const e of bandBeatEvents({ ...base, level, beatInBar, phraseBar: 1 })) {
          expect(e.offsetBeats).toBeGreaterThanOrEqual(0);
          expect(e.offsetBeats).toBeLessThan(1);
        }
      }
    }
  });

  it('thins out with a sparse click (the Ghost road)', () => {
    expect(voices({ level: 3, beatInBar: 0, placement: 'backbeat-2-4' })).toEqual([]);
    expect(voices({ level: 3, beatInBar: 1, placement: 'backbeat-2-4' })).toEqual(
      expect.arrayContaining(['snare']),
    );
    expect(voices({ level: 3, beatInBar: 0, placement: 'one-drop-1' })).toContain('kick');
    expect(voices({ level: 3, beatInBar: 2, placement: 'one-drop-1' })).toEqual([]);
    const offbeats = bandBeatEvents({ ...base, level: 3, beatInBar: 2, placement: 'offbeat-and' });
    expect(offbeats.every((e) => e.offsetBeats === 0.5)).toBe(true);
  });

  it('goes quiet in a silent bar', () => {
    expect(voices({ level: 5, beatInBar: 0, silent: true })).toEqual([]);
  });

  it('plays a snare fill on the last beat of a fill bar, even at the click level', () => {
    const fill = bandBeatEvents({ ...base, level: 0, beatInBar: 3, fill: true });
    const snares = fill.filter((e) => e.voice === 'snare');
    expect(snares.map((e) => e.offsetBeats)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(snares[3].level).toBeGreaterThan(snares[0].level);
    expect(voices({ level: 0, beatInBar: 2, fill: true })).toEqual(['click']);
  });

  it('marks a new section with a crash on its downbeat', () => {
    expect(voices({ level: 2, beatInBar: 0, crash: true })).toContain('crash');
    expect(voices({ level: 0, beatInBar: 0, crash: true })).not.toContain('crash');
  });
});
