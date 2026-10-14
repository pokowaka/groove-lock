import { describe, expect, it } from 'vitest';
import {
  describeBassVoiceNote,
  frequencyToPitchEstimate,
  noteClassToBassFrequencyHz,
} from '../src/dsp/pitch-utils';
import {
  isBassGuideActiveForBar,
  isStepAudible,
  resolvePatternBarSteps,
} from '../src/groove/patterns';
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

describe('v0.3 Groove Patterns, Reference Bass Guide & Click Placement Modes', () => {
  it('generates Motown (1, 2-&, 3, 4) and Funk 16th syncopated active step masks with musical gate durations', () => {
    const motown = resolvePatternBarSteps('motown-pocket', 1);
    expect(motown).toHaveLength(8);
    const activeMotownIndices = motown
      .filter((s) => s.isTargetActive)
      .map((s) => s.stepInBar);
    expect(activeMotownIndices).toEqual([0, 3, 4, 6]);
    // Motown Beat 1 holds for a dotted-quarter sustain (~1.38 beats) before the 2-& pickup
    expect(motown[0].gateBeats).toBeGreaterThan(1.2);
    expect(motown[3].gateBeats).toBeLessThan(0.5);

    const funk = resolvePatternBarSteps('funk-16th', 1);
    expect(funk).toHaveLength(16);
    const activeFunkIndices = funk
      .filter((s) => s.isTargetActive)
      .map((s) => s.stepInBar);
    expect(activeFunkIndices).toEqual([0, 3, 6, 8, 9, 14]);
    // Step 6 (2-&) and Step 14 (4-&) are octave pops (+1 octave)
    expect(funk[6].octaveShift).toBe(1);
    expect(funk[14].octaveShift).toBe(1);

    const octaves = resolvePatternBarSteps('octaves-8th', 1);
    expect(octaves.map((s) => s.octaveShift)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
  });

  it('maps target note classes to 1st-position electric bass fundamentals, fretboard hints, and Call & Response bars', () => {
    // Open E1 = 41.203 Hz, Open A1 = 55.0 Hz, Open D2 = 73.416 Hz
    expect(noteClassToBassFrequencyHz('E', 'bass', 0)).toBeCloseTo(41.203, 2);
    expect(noteClassToBassFrequencyHz('ANY', 'bass', 0)).toBeCloseTo(41.203, 2);
    expect(noteClassToBassFrequencyHz('A', 'bass', 0)).toBeCloseTo(55.0, 2);
    expect(noteClassToBassFrequencyHz('A', 'bass', 1)).toBeCloseTo(110.0, 2);
    expect(noteClassToBassFrequencyHz('E', 'guitar', 0)).toBeCloseTo(82.407, 2);

    const e1Voice = describeBassVoiceNote('ANY', 'bass', 0);
    expect(e1Voice.fullName).toBe('E1');
    expect(e1Voice.fretboardHint).toContain('E-String Open');

    const e2OctaveVoice = describeBassVoiceNote('E', 'bass', 1);
    expect(e2OctaveVoice.fullName).toBe('E2');
    expect(e2OctaveVoice.fretboardHint).toContain('D-String Fret 2');

    // Call & Response (1 Demo / 1 You)
    expect(isBassGuideActiveForBar(0, 'call-response-1-1')).toBe(true);
    expect(isBassGuideActiveForBar(1, 'call-response-1-1')).toBe(false);
    expect(isBassGuideActiveForBar(2, 'call-response-1-1')).toBe(true);

    // Call & Response (1 Demo / 3 You)
    expect(isBassGuideActiveForBar(0, 'call-response-1-3')).toBe(true);
    expect(isBassGuideActiveForBar(1, 'call-response-1-3')).toBe(false);
    expect(isBassGuideActiveForBar(2, 'call-response-1-3')).toBe(false);
    expect(isBassGuideActiveForBar(3, 'call-response-1-3')).toBe(false);
    expect(isBassGuideActiveForBar(4, 'call-response-1-3')).toBe(true);

    // Demo first: the reference bass plays only the first bar after (re)start, then you play the rest
    expect(isBassGuideActiveForBar(0, 'demo-first')).toBe(true);
    expect(isBassGuideActiveForBar(1, 'demo-first')).toBe(false);
    expect(isBassGuideActiveForBar(4, 'demo-first')).toBe(false);
    expect(isBassGuideActiveForBar(7, 'demo-first')).toBe(false);
  });

  it('generates 62% swung step durations in shuffle-swing mode summing to 4.0 beats per bar', () => {
    const shuffle = resolvePatternBarSteps('shuffle-swing', 1);
    expect(shuffle).toHaveLength(8);
    expect(shuffle[0].durationBeats).toBeCloseTo(0.62, 3);
    expect(shuffle[1].durationBeats).toBeCloseTo(0.38, 3);
    const totalBarBeats = shuffle.reduce((acc, s) => acc + s.durationBeats, 0);
    expect(totalBarBeats).toBeCloseTo(4.0, 4);
  });

  it('filters audible clicks correctly for Backbeat (2 & 4), One-Drop (Beat 1), and Off-Beat (&)', () => {
    const eighthSteps = resolvePatternBarSteps('uniform', 2);

    const backbeatAudible = eighthSteps
      .filter((s) => isStepAudible(s, 'backbeat-2-4', false))
      .map((s) => s.stepInBar);
    // Beat 2 downbeat = step 2, Beat 4 downbeat = step 6
    expect(backbeatAudible).toEqual([2, 6]);

    const oneDropAudible = eighthSteps
      .filter((s) => isStepAudible(s, 'one-drop-1', false))
      .map((s) => s.stepInBar);
    expect(oneDropAudible).toEqual([0]);

    const offbeatAudible = eighthSteps
      .filter((s) => isStepAudible(s, 'offbeat-and', false))
      .map((s) => s.stepInBar);
    expect(offbeatAudible).toEqual([1, 3, 5, 7]);

    // Beats only: the subdivisions stay silent, so a 16th rhythm is felt against plain quarters.
    const sixteenths = resolvePatternBarSteps('uniform', 4);
    const beatsAudible = sixteenths
      .filter((s) => isStepAudible(s, 'beats', false))
      .map((s) => s.stepInBar);
    expect(beatsAudible).toEqual([0, 4, 8, 12]);
  });
});

describe('PocketGrader — Micro-Timing, Feel Offset & Speed Trainer', () => {
  it('grades each target only once: a second pluck near the same beat is ignored', () => {
    const grader = new PocketGrader();
    grader.pushTargetEvent(makeTarget(0, 0, 1.0));
    grader.pushTargetEvent(makeTarget(0, 1, 1.6));
    const params = { latencyCompensationMs: 0, bpm: 100, subdivision: 1 as const, pocketWindowMs: 16 };

    const first = grader.evaluatePluck({ rawOnsetTimeSec: 1.005, pitch: null, peakRms: 0.1 }, params);
    expect(first?.offsetMs).toBeCloseTo(5, 3);
    // e.g. a false re-trigger or an extra note 180 ms later, still closest to beat 1
    const extra = grader.evaluatePluck({ rawOnsetTimeSec: 1.185, pitch: null, peakRms: 0.1 }, params);
    expect(extra).toBeNull();
    expect(grader.getStats(16).totalHits).toBe(1);
    // the next beat is still graded normally
    const second = grader.evaluatePluck({ rawOnsetTimeSec: 1.59, pitch: null, peakRms: 0.1 }, params);
    expect(second?.offsetMs).toBeCloseTo(-10, 3);
  });

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

  it('supports Laid-Back (+12 ms) Pocket Feel Offset and triggers Speed Trainer after 4 clean bars', () => {
    const grader = new PocketGrader();
    const e1Pitch = frequencyToPitchEstimate(41.203, 0.99);

    // Schedule 4 bars of 2 hits each, played at +22ms behind the grid
    // With pocketCenterMs = +12ms and pocketWindowMs = 12ms, +22ms is within [0ms, +24ms] -> IN POCKET!
    for (let bar = 0; bar < 4; bar++) {
      const t0 = 1.0 + bar * 2.0;
      const t1 = t0 + 0.6;
      grader.pushTargetEvent(makeTarget(bar, 0, t0, 'ANY'));
      grader.pushTargetEvent(makeTarget(bar, 1, t1, 'ANY'));

      const g0 = grader.evaluatePluck(
        { rawOnsetTimeSec: t0 + 0.022, pitch: e1Pitch, peakRms: 0.15 },
        {
          latencyCompensationMs: 0,
          bpm: 100,
          subdivision: 1,
          pocketWindowMs: 12,
          pocketCenterMs: 12,
        },
      );
      const g1 = grader.evaluatePluck(
        { rawOnsetTimeSec: t1 + 0.022, pitch: e1Pitch, peakRms: 0.15 },
        {
          latencyCompensationMs: 0,
          bpm: 100,
          subdivision: 1,
          pocketWindowMs: 12,
          pocketCenterMs: 12,
        },
      );
      expect(g0?.inPocket).toBe(true);
      expect(g1?.inPocket).toBe(true);
    }

    expect(grader.consumeSpeedTrainerStepUpIfReady(4, 0.85)).toBe(true);
    // Consuming resets the window so it does not double-trigger on the same bar
    expect(grader.consumeSpeedTrainerStepUpIfReady(4, 0.85)).toBe(false);
  });
});
