import { formatBeatLabel, type Subdivision } from './timeline';

/**
 * Audible reference sound engine mode:
 * - `'click'`: Pitched studio woodblock/beep click (`1320 Hz` / `880 Hz` / `587 Hz`)
 * - `'drums'`: Synthesized studio drum kit (Kick on 1 & 3, Snare on 2 & 4, Hi-Hat on subdivisions)
 */
export type SoundEngineMode = 'click' | 'drums';

/**
 * Controls when the synthesized Reference Bass voice plays the target groove pattern:
 * - `'off'`: Reference bass only plays when clicking the 1-Bar "Hear Bass Groove" preview button
 * - `'call-response-1-1'`: GrooveLock plays Bar 1 (Call), you play Bar 2 (Response)
 * - `'call-response-1-3'`: GrooveLock plays Bar 1 (Call), you play Bars 2–4 (Response)
 * - `'always'`: Reference bass plays continuously alongside the click/drums
 */
export type BassGuideMode =
  | 'off'
  | 'call-response-1-1'
  | 'call-response-1-3'
  | 'always';

/**
 * Controls which beats of a 4/4 bar emit an audible click or drum transient:
 * - `'all'`: All 4 beats (and subdivisions when applicable)
 * - `'backbeat-2-4'`: Beats 2 & 4 only (classic Carol Kaye / Victor Wooten backbeat lock drill)
 * - `'one-drop-1'`: Beat 1 of each bar only ("One-Drop" internal clock drill)
 * - `'offbeat-and'`: Eighth-note off-beats (`&`) only
 */
export type ClickPlacementMode =
  | 'all'
  | 'backbeat-2-4'
  | 'one-drop-1'
  | 'offbeat-and';

/**
 * Built-in rhythmic groove pattern templates for `v0.3` (The Pocket Laboratory):
 * - `'uniform'`: Continuous uniform subdivision grid (uses the `Subdivision` selector: 1, 2, 3, or 4)
 * - `'motown-pocket'`: Classic Motown Dotted-Quarter + Eighth (`1`, `2-&`, `3`, `4`)
 * - `'funk-16th'`: Syncopated 16th-note funk pocket (`1`, `1-a`, `2-&`, `3`, `3-e`, `4-&`)
 * - `'shuffle-swing'`: Swung 8th-note shuffle (62% triplet-pocket swing ratio on upbeats)
 * - `'octaves-8th'`: Driving 8th-note studio pulse (`1 & 2 & 3 & 4 &`)
 */
export type GroovePatternId =
  | 'uniform'
  | 'motown-pocket'
  | 'funk-16th'
  | 'shuffle-swing'
  | 'octaves-8th';

/**
 * Intentional micro-timing pocket center offset in milliseconds:
 * - `0`: Dead Center (`0 ms`)
 * - `12`: Laid-Back / Behind the Beat (`+12 ms`, Neo-Soul / R&B pocket)
 * - `-8`: Pushed / On Top of the Beat (`-8 ms`, driving Rock / Punk pocket)
 */
export type PocketFeelOffsetMs = 0 | 12 | -8;

/**
 * Auto-Tempo Speed Trainer step-up increment (in BPM per 4 clean bars):
 * - `0`: Disabled
 * - `2`: `+2 BPM` every 4 active bars with >= 85% in-pocket accuracy
 * - `4`: `+4 BPM` every 4 active bars with >= 85% in-pocket accuracy
 */
export type SpeedTrainerStep = 0 | 2 | 4;

/**
 * Describes a single rhythmic step within a 4/4 bar.
 */
export interface PatternStepDescriptor {
  /** Zero-based index of this step within the bar (`0 .. totalSteps-1`). */
  readonly stepInBar: number;
  /** Quarter-note beat index (`0..3`). */
  readonly beatInBar: number;
  /** Subdivision index within the beat (`0 .. subdivision-1`). */
  readonly subIndex: number;
  /** Effective subdivision density of the bar (`1..4`). */
  readonly subdivision: Subdivision;
  /**
   * Duration of this step in fractions of a quarter-note beat.
   * For straight grids, equals `1 / subdivision`.
   * For `'shuffle-swing'`, downbeats are `0.62` beats and swung upbeats are `0.38` beats.
   */
  readonly durationBeats: number;
  /**
   * Musical sustain gate length in quarter-note beats when synthesized by the Reference Bass.
   */
  readonly gateBeats: number;
  /**
   * Octave offset (`0` = root, `1` = +1 octave) used by the Reference Bass synth for musical articulation
   * (note evaluation still accepts any octave of the target pitch class).
   */
  readonly octaveShift: number;
  /** Short UI label for the 16-step pattern strip (e.g. `"1"`, `"&"`, `"e"`, `"a"`). */
  readonly shortStepLabel: string;
  /** Full beat coordinate label (e.g. `"Beat 1"`, `"2.2"`). */
  readonly beatLabel: string;
  /** `true` if the bass player is expected to pluck on this step of the groove pattern. */
  readonly isTargetActive: boolean;
}

const SIXTEENTH_STEP_LABELS = ['1', 'e', '&', 'a'] as const;
const EIGHTH_STEP_LABELS = ['1', '&'] as const;
const TRIPLET_STEP_LABELS = ['1', 'trip', 'let'] as const;

function getShortStepLabel(
  beatInBar: number,
  subIndex: number,
  subdivision: Subdivision,
): string {
  if (subIndex === 0) {
    return String(beatInBar + 1);
  }
  if (subdivision === 2) {
    return EIGHTH_STEP_LABELS[subIndex] ?? '&';
  }
  if (subdivision === 3) {
    return TRIPLET_STEP_LABELS[subIndex] ?? 't';
  }
  return SIXTEENTH_STEP_LABELS[subIndex] ?? '+';
}

/**
 * Resolves the sequence of `PatternStepDescriptor`s for a single 4/4 bar given the
 * selected `GroovePatternId` and fallback `uniformSubdivision`.
 */
export function resolvePatternBarSteps(
  patternId: GroovePatternId,
  uniformSubdivision: Subdivision,
): readonly PatternStepDescriptor[] {
  if (patternId === 'motown-pocket') {
    // 8th-note grid (8 steps/bar): active on Beat 1 (0), Beat 2-& (3), Beat 3 (4), Beat 4 (6)
    const gateByStep: Readonly<Record<number, number>> = {
      0: 1.4, // Dotted-quarter sustain across 1, 1-&, 2
      3: 0.45, // Eighth-note pickup on 2-&
      4: 0.9, // Quarter-note on 3
      6: 0.9, // Quarter-note on 4
    };
    return buildStraightBarSteps(
      2,
      (step) => step in gateByStep,
      (step) => gateByStep[step] ?? 0.4,
      (step) => (step === 3 ? 1 : 0),
    );
  }

  if (patternId === 'funk-16th') {
    // 16th-note grid (16 steps/bar): active on 1 (0), 1-a (3), 2-& (6), 3 (8), 3-e (9), 4-& (14)
    const gateByStep: Readonly<Record<number, number>> = {
      0: 0.55,
      3: 0.22,
      6: 0.38,
      8: 0.22,
      9: 0.65,
      14: 0.38,
    };
    return buildStraightBarSteps(
      4,
      (step) => step in gateByStep,
      (step) => gateByStep[step] ?? 0.2,
      (step) => (step === 6 || step === 14 ? 1 : 0),
    );
  }

  if (patternId === 'octaves-8th') {
    return buildStraightBarSteps(
      2,
      () => true,
      () => 0.42,
      (step) => step % 2, // Root on downbeats, +1 octave on '&' upbeats
    );
  }

  if (patternId === 'shuffle-swing') {
    const steps: PatternStepDescriptor[] = [];
    const sub: Subdivision = 2;
    for (let step = 0; step < 8; step++) {
      const beatInBar = Math.floor(step / 2);
      const subIndex = step % 2;
      const durationBeats = subIndex === 0 ? 0.62 : 0.38;
      steps.push({
        stepInBar: step,
        beatInBar,
        subIndex,
        subdivision: sub,
        durationBeats,
        gateBeats: durationBeats * 0.84,
        octaveShift: 0,
        shortStepLabel: getShortStepLabel(beatInBar, subIndex, sub),
        beatLabel: formatBeatLabel(beatInBar, subIndex),
        isTargetActive: true,
      });
    }
    return steps;
  }

  // Default 'uniform' mode
  const stepDur = 1 / uniformSubdivision;
  return buildStraightBarSteps(
    uniformSubdivision,
    () => true,
    () => stepDur * 0.82,
    () => 0,
  );
}

function buildStraightBarSteps(
  subdivision: Subdivision,
  isActiveFn: (stepInBar: number) => boolean,
  gateBeatsFn: (stepInBar: number) => number,
  octaveShiftFn: (stepInBar: number) => number,
): readonly PatternStepDescriptor[] {
  const totalSteps = 4 * subdivision;
  const steps: PatternStepDescriptor[] = [];
  for (let step = 0; step < totalSteps; step++) {
    const beatInBar = Math.floor(step / subdivision);
    const subIndex = step % subdivision;
    steps.push({
      stepInBar: step,
      beatInBar,
      subIndex,
      subdivision,
      durationBeats: 1 / subdivision,
      gateBeats: gateBeatsFn(step),
      octaveShift: octaveShiftFn(step),
      shortStepLabel: getShortStepLabel(beatInBar, subIndex, subdivision),
      beatLabel: formatBeatLabel(beatInBar, subIndex),
      isTargetActive: isActiveFn(step),
    });
  }
  return steps;
}

/**
 * Determines whether the synthesized Reference Bass should play during `barNumber`
 * under the selected `BassGuideMode`.
 */
export function isBassGuideActiveForBar(
  barNumber: number,
  guideMode: BassGuideMode,
): boolean {
  switch (guideMode) {
    case 'off':
      return false;
    case 'always':
      return true;
    case 'call-response-1-1':
      return barNumber % 2 === 0;
    case 'call-response-1-3':
      return barNumber % 4 === 0;
  }
}

/**
 * Determines whether a given step in the bar should emit an audible click/drum sound
 * under the active `ClickPlacementMode` and `GapClickMode`.
 */
export function isStepAudible(
  step: PatternStepDescriptor,
  placementMode: ClickPlacementMode,
  isSilentGapBar: boolean,
): boolean {
  if (isSilentGapBar) {
    return false;
  }

  switch (placementMode) {
    case 'all':
      return true;
    case 'backbeat-2-4':
      return (
        step.subIndex === 0 && (step.beatInBar === 1 || step.beatInBar === 3)
      );
    case 'one-drop-1':
      return step.subIndex === 0 && step.beatInBar === 0;
    case 'offbeat-and':
      if (step.subdivision === 2) {
        return step.subIndex === 1;
      }
      if (step.subdivision === 4) {
        return step.subIndex === 2;
      }
      return step.subIndex === 1;
  }
}

/**
 * Human-readable display label for a `GroovePatternId` + `Subdivision`.
 */
export function formatPatternSummary(
  bpm: number,
  patternId: GroovePatternId,
  subdivision: Subdivision,
): string {
  const subLabels: Record<Subdivision, string> = {
    1: 'Quarter Notes',
    2: 'Eighth Notes',
    3: 'Triplets',
    4: 'Sixteenth Notes',
  };
  const patternLabels: Record<GroovePatternId, string> = {
    uniform: subLabels[subdivision],
    'motown-pocket': 'Motown Pocket (1, 2-&, 3, 4)',
    'funk-16th': 'Funk 16th Syncopation',
    'shuffle-swing': 'Swung 8th Shuffle (62%)',
    'octaves-8th': 'Driving 8th Pulse',
  };
  return `${bpm} BPM · ${patternLabels[patternId]}`;
}
