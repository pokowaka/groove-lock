import { FOURTHS_CYCLE, NOTE_NAMES } from '../dsp/pitch-utils';
import type { NoteClass } from '../dsp/types';

/**
 * Target note exercise mode:
 * - `'free'`: Any pitch accepted (`expectedNote === 'ANY'`)
 * - `'root-cycle'`: Advances through the Circle of Fourths (`E -> A -> D -> G -> C -> F...`) every bar
 * - `'random-bar'`: Selects a random chromatic pitch class every bar
 * - `'fixed-e'`: Locks target note to `E` (any octave)
 * - `'fixed-a'`: Locks target note to `A` (any octave)
 */
export type DrillMode =
  | 'free'
  | 'root-cycle'
  | 'random-bar'
  | 'fixed-e'
  | 'fixed-a';

/**
 * Metronome subdivision steps per quarter-note beat:
 * - `1`: Quarter notes (1 per beat)
 * - `2`: Eighth notes (2 per beat)
 * - `3`: Triplets (3 per beat)
 * - `4`: Sixteenth notes (4 per beat)
 */
export type Subdivision = 1 | 2 | 3 | 4;

/**
 * Gap-click internal clock trainer mode (in 4-bar phrases):
 * - `0`: Continuous click (all 4 bars audible)
 * - `1`: 3 bars audible click + 1 bar silent gap (bar 4 muted)
 * - `2`: 2 bars audible click + 2 bars silent gap (bars 3 & 4 muted)
 */
export type GapClickMode = 0 | 1 | 2;

/**
 * Universal timeline note event.
 *
 * Serves as the decoupling contract between rhythm/note generators (such as the
 * procedural metronome today, or an external song/YouTube beatmap in the future)
 * and the `PocketGrader` evaluation engine.
 */
export interface TargetNoteEvent {
  /** Unique identifier (`"${barNumber}:${beatInBar}:${subIndex}"`). */
  readonly id: string;
  /** Scheduled target timestamp in `outputCtx.currentTime` seconds. */
  readonly timeSec: number;
  /** Zero-based bar number since transport start. */
  readonly barNumber: number;
  /** Beat index within the 4/4 bar (`0..3`). */
  readonly beatInBar: number;
  /** Subdivision index within the current beat (`0..subdivision-1`). */
  readonly subIndex: number;
  /** Human-readable beat coordinate (e.g. `"Beat 1"` or `"2.3"`). */
  readonly beatLabel: string;
  /** Required pitch class for this event, or `'ANY'` in free groove mode. */
  readonly expectedNote: NoteClass | 'ANY';
  /** `true` if the metronome click was intentionally muted by the Gap Click trainer. */
  readonly isSilentGapBar: boolean;
  /** Optional string and fret hint for future tablature / play-along chart modes. */
  readonly stringAndFret?: {
    readonly stringNumber: number;
    readonly fret: number;
  };
}

/**
 * Target note and UI status caption computed at the start of a bar.
 */
export interface BarTargetState {
  readonly targetNote: NoteClass | 'ANY';
  readonly statusCaption: string;
}

/**
 * Computes the target pitch class and helper caption for a given `drillMode` and `barNumber`.
 *
 * @param drillMode Active note drill exercise mode.
 * @param barNumber Zero-based bar counter.
 * @param randomIndex Optional deterministic index for unit testing `'random-bar'`.
 */
export function computeBarTarget(
  drillMode: DrillMode,
  barNumber: number,
  randomIndex?: number,
): BarTargetState {
  switch (drillMode) {
    case 'free':
      return {
        targetNote: 'ANY',
        statusCaption: 'Free groove mode',
      };
    case 'fixed-e':
      return {
        targetNote: 'E',
        statusCaption: 'Play E on the grid',
      };
    case 'fixed-a':
      return {
        targetNote: 'A',
        statusCaption: 'Play A on the grid',
      };
    case 'root-cycle': {
      const idx =
        ((barNumber % FOURTHS_CYCLE.length) + FOURTHS_CYCLE.length) %
        FOURTHS_CYCLE.length;
      const nextIdx = (idx + 1) % FOURTHS_CYCLE.length;
      return {
        targetNote: FOURTHS_CYCLE[idx],
        statusCaption: `Next bar: ${FOURTHS_CYCLE[nextIdx]}`,
      };
    }
    case 'random-bar': {
      const idx =
        randomIndex !== undefined
          ? ((randomIndex % NOTE_NAMES.length) + NOTE_NAMES.length) %
            NOTE_NAMES.length
          : Math.floor(Math.random() * NOTE_NAMES.length);
      return {
        targetNote: NOTE_NAMES[idx],
        statusCaption: 'New random note each bar',
      };
    }
  }
}

/**
 * Determines whether a given zero-based `barNumber` should mute its audible metronome
 * clicks under the active `GapClickMode`.
 */
export function isBarSilentInGapMode(
  barNumber: number,
  gapMode: GapClickMode,
): boolean {
  if (gapMode === 1) {
    return barNumber % 4 === 3;
  }
  if (gapMode === 2) {
    return barNumber % 4 >= 2;
  }
  return false;
}

/**
 * Formats a zero-based beat and subdivision index into a compact display label.
 */
export function formatBeatLabel(beatInBar: number, subIndex: number): string {
  return subIndex === 0
    ? `Beat ${beatInBar + 1}`
    : `${beatInBar + 1}.${subIndex + 1}`;
}
