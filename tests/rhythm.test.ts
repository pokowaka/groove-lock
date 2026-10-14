import { describe, expect, it } from 'vitest';
import {
  parseRhythm,
  resolveRhythmBarSteps,
  rhythmFromStorage,
  type Rhythm,
} from '../src/groove/rhythm';

const active = (r: Rhythm, bar = 0): number[] =>
  resolveRhythmBarSteps(r, bar)
    .filter((s) => s.isTargetActive)
    .map((s) => s.stepInBar);

describe('rhythm masks', () => {
  it('turns a 16th mask into one bar of steps with notes where the x are', () => {
    const r: Rhythm = { subdivision: 4, bars: ['x... ..x. .... ...x'] };
    const steps = resolveRhythmBarSteps(r, 0);
    expect(steps).toHaveLength(16);
    expect(active(r)).toEqual([0, 6, 15]);
    expect(steps[6].beatInBar).toBe(1);
    expect(steps[6].subIndex).toBe(2);
    expect(steps[6].shortStepLabel).toBe('&');
    expect(steps[15].shortStepLabel).toBe('a');
    expect(steps.every((s) => s.durationBeats === 0.25)).toBe(true);
  });

  it('reads written note length from the holds after each note', () => {
    // Motown: dotted quarter, 8th pickup, two quarters.
    const steps = resolveRhythmBarSteps({ subdivision: 2, bars: ['x--xx-x-'] }, 0);
    expect(steps[0].lengthBeats).toBeCloseTo(1.5);
    expect(steps[3].lengthBeats).toBeCloseTo(0.5);
    expect(steps[4].lengthBeats).toBeCloseTo(1);
    expect(steps[6].lengthBeats).toBeCloseTo(1);
    // Rests and holds are not notes and have no length of their own.
    expect(steps[1].lengthBeats).toBe(0);
    expect(steps[1].isTargetActive).toBe(false);
  });

  it('plays the reference bass a little shorter than the written length', () => {
    const steps = resolveRhythmBarSteps({ subdivision: 2, bars: ['x--xx-x-'] }, 0);
    expect(steps[0].gateBeats).toBeLessThan(steps[0].lengthBeats);
    expect(steps[0].gateBeats).toBeGreaterThan(1.2);
  });

  it('marks o notes an octave up', () => {
    const steps = resolveRhythmBarSteps({ subdivision: 2, bars: ['xoxoxoxo'] }, 0);
    expect(steps.map((s) => s.octaveShift)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('cycles through the bars of a multi-bar phrase', () => {
    const r: Rhythm = { subdivision: 1, bars: ['x...', '.x..', '..x.'] };
    expect(active(r, 0)).toEqual([0]);
    expect(active(r, 1)).toEqual([1]);
    expect(active(r, 2)).toEqual([2]);
    expect(active(r, 3)).toEqual([0]);
    expect(active(r, 7)).toEqual([1]);
  });

  it('holds a note across the bar line', () => {
    const r: Rhythm = { subdivision: 1, bars: ['...x', '--..'] };
    expect(resolveRhythmBarSteps(r, 0)[3].lengthBeats).toBe(3);
    // A hold at the start of the phrase continues the last note of the phrase.
    const wrap: Rhythm = { subdivision: 1, bars: ['-x..', '...x'] };
    expect(resolveRhythmBarSteps(wrap, 1)[3].lengthBeats).toBe(2);
  });

  it('swings pairs of steps', () => {
    const steps = resolveRhythmBarSteps({ subdivision: 2, bars: ['xxxxxxxx'], swing: 0.62 }, 0);
    expect(steps[0].durationBeats).toBeCloseTo(0.62);
    expect(steps[1].durationBeats).toBeCloseTo(0.38);
    expect(steps[0].lengthBeats).toBeCloseTo(0.62);
    const total = steps.reduce((a, s) => a + s.durationBeats, 0);
    expect(total).toBeCloseTo(4);

    const sixteenths = resolveRhythmBarSteps({ subdivision: 4, bars: ['x-x-x-x-x-x-x-x-'], swing: 0.6 }, 0);
    expect(sixteenths[0].durationBeats).toBeCloseTo(0.3);
    expect(sixteenths[1].durationBeats).toBeCloseTo(0.2);
    expect(sixteenths[0].lengthBeats).toBeCloseTo(0.5);
  });

  it('ignores spaces and bar separators', () => {
    expect(parseRhythm({ subdivision: 1, bars: ['x . | x .'] }).bars[0]).toBe('x.x.');
  });

  it('rejects malformed masks', () => {
    expect(() => parseRhythm({ subdivision: 2, bars: ['x...'] })).toThrow(/8 steps/);
    expect(() => parseRhythm({ subdivision: 1, bars: ['x.?.'] })).toThrow(/symbol/);
    expect(() => parseRhythm({ subdivision: 1, bars: ['....'] })).toThrow(/no notes/);
    expect(() => parseRhythm({ subdivision: 1, bars: [] })).toThrow(/no bars/);
    expect(() => parseRhythm({ subdivision: 3, bars: ['xxxxxxxxxxxx'], swing: 0.6 })).toThrow(/swing/);
  });
});

describe('stored rhythms', () => {
  it('accepts a valid stored rhythm and rejects anything else', () => {
    expect(rhythmFromStorage({ subdivision: 4, bars: ['x... .... .... ...x'] })).toEqual({
      subdivision: 4,
      bars: ['x..............x'],
    });
    expect(rhythmFromStorage({ subdivision: 2, bars: ['xxxxxxxx'], swing: 0.6 })?.swing).toBe(0.6);
    expect(rhythmFromStorage(null)).toBeNull();
    expect(rhythmFromStorage('x...')).toBeNull();
    expect(rhythmFromStorage({ subdivision: 5, bars: ['x....'] })).toBeNull();
    expect(rhythmFromStorage({ subdivision: 1, bars: ['x..'] })).toBeNull();
    expect(rhythmFromStorage({ subdivision: 1, bars: [7] })).toBeNull();
  });
});
