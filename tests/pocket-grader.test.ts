import { describe, expect, it } from 'vitest';
import { frequencyToPitchEstimate } from '../src/dsp/pitch-utils';
import { PocketGrader } from '../src/groove/pocket-grader';
import {
  computeBarTarget,
  formatBeatLabel,
  isBarSilentInGapMode,
  type TargetNoteEvent,
} from '../src/groove/timeline';

function makeTarget(
  bar: number,
  beat: number,
  timeSec: number,
  expectedNote: TargetNoteEvent['expectedNote'] = 'ANY',
): TargetNoteEvent {
  return {
    id: `${bar}:${beat}:0`,
    timeSec,
    barNumber: bar,
    beatInBar: beat,
    subIndex: 0,
    beatLabel: formatBeatLabel(beat, 0),
    expectedNote,
    isSilentGapBar: false,
  };
}

describe('Timeline & Target Note Generators', () => {
  it('cycles through the Circle of Fourths in root-cycle drill mode', () => {
    const bar0 = computeBarTarget('root-cycle', 0);
    const bar1 = computeBarTarget('root-cycle', 1);
    const bar2 = computeBarTarget('root-cycle', 2);
    const bar3 = computeBarTarget('root-cycle', 3);

    expect(bar0.targetNote).toBe('E');
    expect(bar1.targetNote).toBe('A');
    expect(bar2.targetNote).toBe('D');
    expect(bar3.targetNote).toBe('G');
  });

  it('computes gap-click silent bars for 3+1 and 2+2 gap modes', () => {
    expect(isBarSilentInGapMode(0, 1)).toBe(false);
    expect(isBarSilentInGapMode(1, 1)).toBe(false);
    expect(isBarSilentInGapMode(2, 1)).toBe(false);
    expect(isBarSilentInGapMode(3, 1)).toBe(true);

    expect(isBarSilentInGapMode(0, 2)).toBe(false);
    expect(isBarSilentInGapMode(1, 2)).toBe(false);
    expect(isBarSilentInGapMode(2, 2)).toBe(true);
    expect(isBarSilentInGapMode(3, 2)).toBe(true);
  });
});

describe('PocketGrader — Micro-Timing & Session Statistics', () => {
  it('applies latency compensation and classifies pocket, rushing, and dragging plucks', () => {
    const grader = new PocketGrader();
    // 100 BPM quarter notes: 0.6s per beat (t = 1.0, 1.6, 2.2, 2.8)
    grader.pushTargetEvent(makeTarget(0, 0, 1.0, 'E'));
    grader.pushTargetEvent(makeTarget(0, 1, 1.6, 'E'));
    grader.pushTargetEvent(makeTarget(0, 2, 2.2, 'E'));
    grader.pushTargetEvent(makeTarget(0, 3, 2.8, 'E'));

    const e1Pitch = frequencyToPitchEstimate(41.203, 0.99);
    const a1Pitch = frequencyToPitchEstimate(55.0, 0.99);
    const params = {
      latencyCompensationMs: 20, // 20ms hardware latency
      bpm: 100,
      subdivision: 1 as const,
      pocketWindowMs: 16,
    };

    // Beat 1: raw onset at 1.024s -> compensated = 1.004s (+4ms -> in pocket, matched E)
    const hit1 = grader.evaluatePluck(
      { rawOnsetTimeSec: 1.024, pitch: e1Pitch, peakRms: 0.12 },
      params,
    );
    expect(hit1).not.toBeNull();
    expect(hit1?.inPocket).toBe(true);
    expect(hit1?.verdict).toBe('pocket');
    expect(hit1?.noteMatched).toBe(true);
    expect(hit1?.offsetMs).toBeCloseTo(4.0, 2);

    // Beat 2: raw onset at 1.595s -> compensated = 1.575s (-25ms -> rushing)
    const hit2 = grader.evaluatePluck(
      { rawOnsetTimeSec: 1.595, pitch: e1Pitch, peakRms: 0.12 },
      params,
    );
    expect(hit2?.inPocket).toBe(false);
    expect(hit2?.verdict).toBe('rushing');
    expect(hit2?.offsetMs).toBeCloseTo(-25.0, 2);

    // Beat 3: raw onset at 2.250s -> compensated = 2.230s (+30ms -> dragging, wrong pitch A1)
    const hit3 = grader.evaluatePluck(
      { rawOnsetTimeSec: 2.25, pitch: a1Pitch, peakRms: 0.12 },
      params,
    );
    expect(hit3?.inPocket).toBe(false);
    expect(hit3?.verdict).toBe('dragging');
    expect(hit3?.noteMatched).toBe(false);
    expect(hit3?.offsetMs).toBeCloseTo(30.0, 2);

    // Check aggregated session stats
    const stats = grader.getStats(16);
    expect(stats.totalHits).toBe(3);
    expect(stats.inPocketPct).toBe(33);
    expect(stats.meanOffsetMs).toBeCloseTo((4 - 25 + 30) / 3, 2);
    expect(stats.stdDevMs).toBeGreaterThan(20);
    expect(stats.noteAttempts).toBe(3);
    expect(stats.noteMatches).toBe(2);
  });
});
