import type { PatternStepDescriptor } from './patterns';
import { formatBeatLabel, type Subdivision } from './timeline';

/**
 * A rhythm written as one mask string per 4/4 bar, on a grid of `subdivision` steps per beat.
 *
 * Symbols:
 * - `x`: a note (root)
 * - `o`: a note an octave up
 * - `-`: hold the previous note
 * - `.`: rest
 *
 * Spaces and `|` are ignored, so `'x... ..x. | .... ...x'` is fine.
 *
 * A `-` at the start of a bar continues the last note of the previous bar; at the start of the
 * phrase it wraps around to the last note of the phrase.
 */
export interface Rhythm {
  readonly subdivision: Subdivision;
  /** One mask per bar; multi-bar phrases cycle. */
  readonly bars: readonly string[];
  /**
   * Swing: the share of each pair of steps taken by the first one (`0.5` = straight, `0.62` =
   * shuffle). Only for 8th (`2`) and 16th (`4`) grids.
   */
  readonly swing?: number;
}

/** The reference bass plays this share of the written note length, so notes are separated. */
const GATE_FACTOR = 0.85;

const BEATS_PER_BAR = 4;
const SIXTEENTH_STEP_LABELS = ['1', 'e', '&', 'a'] as const;
const EIGHTH_STEP_LABELS = ['1', '&'] as const;
const TRIPLET_STEP_LABELS = ['1', 'trip', 'let'] as const;

/** Short label of a step for the lane header (`"1"`, `"e"`, `"&"`, `"a"`, `"trip"`, ...). */
export function getShortStepLabel(
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
 * Validates a rhythm and returns it with spaces and `|` stripped from the masks.
 *
 * @throws Error describing the first problem found.
 */
export function parseRhythm(rhythm: Rhythm): Rhythm {
  const { subdivision, swing } = rhythm;
  if (rhythm.bars.length === 0) {
    throw new Error('Rhythm has no bars');
  }
  if (swing !== undefined && swing !== 0.5) {
    if (subdivision !== 2 && subdivision !== 4) {
      throw new Error('Rhythm swing needs an 8th or 16th grid');
    }
    if (!(swing > 0 && swing < 1)) {
      throw new Error(`Rhythm swing ${swing} must be between 0 and 1`);
    }
  }
  const stepsPerBar = BEATS_PER_BAR * subdivision;
  const bars = rhythm.bars.map((raw, i) => {
    const mask = raw.replace(/[\s|]/g, '');
    if (mask.length !== stepsPerBar) {
      throw new Error(`Rhythm bar ${i + 1} has ${mask.length} steps, needs ${stepsPerBar} steps`);
    }
    const bad = mask.match(/[^xo.-]/);
    if (bad) {
      throw new Error(`Rhythm bar ${i + 1} has unknown symbol "${bad[0]}"`);
    }
    return mask;
  });
  if (!bars.some((b) => /[xo]/.test(b))) {
    throw new Error('Rhythm has no notes');
  }
  return { ...rhythm, bars };
}

/** Duration of each step of a bar in beats, honouring swing. */
function stepDurations(subdivision: Subdivision, swing: number | undefined): number[] {
  const straight = 1 / subdivision;
  const s = swing ?? 0.5;
  return Array.from({ length: BEATS_PER_BAR * subdivision }, (_, i) =>
    s === 0.5 ? straight : 2 * straight * (i % 2 === 0 ? s : 1 - s),
  );
}

/**
 * Resolves the steps of bar `barNumber` of a rhythm (phrases cycle), including each note's
 * written length in beats (`lengthBeats`, holds counted, across bar lines too).
 *
 * @throws Error if the rhythm is malformed (see `parseRhythm`).
 */
export function resolveRhythmBarSteps(
  rhythm: Rhythm,
  barNumber: number,
): readonly PatternStepDescriptor[] {
  const { subdivision, swing, bars } = parseRhythm(rhythm);
  const stepsPerBar = BEATS_PER_BAR * subdivision;
  const durations = stepDurations(subdivision, swing);
  const barIndex = ((barNumber % bars.length) + bars.length) % bars.length;
  const phrase = bars.join('');
  const mask = bars[barIndex];

  return Array.from({ length: stepsPerBar }, (_, step) => {
    const symbol = mask[step];
    const isNote = symbol === 'x' || symbol === 'o';
    let lengthBeats = 0;
    if (isNote) {
      const start = barIndex * stepsPerBar + step;
      lengthBeats = durations[step];
      for (let k = 1; k < phrase.length && phrase[(start + k) % phrase.length] === '-'; k++) {
        lengthBeats += durations[(step + k) % stepsPerBar];
      }
    }
    const beatInBar = Math.floor(step / subdivision);
    const subIndex = step % subdivision;
    return {
      stepInBar: step,
      beatInBar,
      subIndex,
      subdivision,
      durationBeats: durations[step],
      lengthBeats,
      gateBeats: lengthBeats * GATE_FACTOR,
      octaveShift: symbol === 'o' ? 1 : 0,
      shortStepLabel: getShortStepLabel(beatInBar, subIndex, subdivision),
      beatLabel: formatBeatLabel(beatInBar, subIndex),
      isTargetActive: isNote,
    };
  });
}

/** Restores a rhythm saved as JSON, or `null` if it is missing or malformed. */
export function rhythmFromStorage(value: unknown): Rhythm | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const v = value as { subdivision?: unknown; bars?: unknown; swing?: unknown };
  const sub = v.subdivision;
  if (sub !== 1 && sub !== 2 && sub !== 3 && sub !== 4) {
    return null;
  }
  if (!Array.isArray(v.bars) || !v.bars.every((b): b is string => typeof b === 'string')) {
    return null;
  }
  if (v.swing !== undefined && typeof v.swing !== 'number') {
    return null;
  }
  try {
    return parseRhythm({
      subdivision: sub,
      bars: v.bars,
      ...(v.swing !== undefined ? { swing: v.swing } : {}),
    });
  } catch {
    return null;
  }
}
