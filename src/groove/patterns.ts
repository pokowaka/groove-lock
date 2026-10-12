import { formatBeatLabel, type Subdivision } from './timeline';

/**
 * Audible reference sound engine mode:
 * - `'click'`: Pitched studio woodblock/beep click (`1320 Hz` / `880 Hz` / `587 Hz`)
 * - `'drums'`: Synthesized studio drum kit (Kick on 1 & 3, Snare on 2 & 4, Hi-Hat on subdivisions)
 */
export type SoundEngineMode = 'click' | 'drums';

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
    const activeSet = new Set([0, 3, 4, 6]);
    return buildStraightBarSteps(2, (step) => activeSet.has(step));
  }

  if (patternId === 'funk-16th') {
    // 16th-note grid (16 steps/bar): active on 1 (0), 1-a (3), 2-& (6), 3 (8), 3-e (9), 4-& (14)
    const activeSet = new Set([0, 3, 6, 8, 9, 14]);
    return buildStraightBarSteps(4, (step) => activeSet.has(step));
  }

  if (patternId === 'octaves-8th') {
    return buildStraightBarSteps(2, () => true);
  }

  if (patternId === 'shuffle-swing') {
    const steps: PatternStepDescriptor[] = [];
    const sub: Subdivision = 2;
    for (let step = 0; step < 8; step++) {
      const beatInBar = Math.floor(step / 2);
      const subIndex = step % 2;
      steps.push({
        stepInBar: step,
        beatInBar,
        subIndex,
        subdivision: sub,
        durationBeats: subIndex === 0 ? 0.62 : 0.38,
        shortStepLabel: getShortStepLabel(beatInBar, subIndex, sub),
        beatLabel: formatBeatLabel(beatInBar, subIndex),
        isTargetActive: true,
      });
    }
    return steps;
  }

  // Default 'uniform' mode
  return buildStraightBarSteps(uniformSubdivision, () => true);
}

function buildStraightBarSteps(
  subdivision: Subdivision,
  isActiveFn: (stepInBar: number) => boolean,
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
      shortStepLabel: getShortStepLabel(beatInBar, subIndex, subdivision),
      beatLabel: formatBeatLabel(beatInBar, subIndex),
      isTargetActive: isActiveFn(step),
    });
  }
  return steps;
}

/**
 * Determines whether a given step in the bar should emit an audible sound under the
 * active `ClickPlacementMode` and `GapClickMode`.
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
