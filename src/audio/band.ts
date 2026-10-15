import type { ClickPlacementMode } from '../groove/patterns';

/**
 * The Groove Road band: a backing arrangement that grows one layer each time you nail a stretch
 * and loses one when you slip. Pure: it only says *what* plays on a beat; the engine schedules it.
 *
 * Layers:
 * 0. click
 * 1. kick + snare backbeat
 * 2. + hi-hat 8ths and a ghost snare
 * 3. + shaker 16ths and tambourine on the backbeat
 * 4. + keys stabs (a chord on the root you play)
 * 5. + a two-bar melodic hook
 */

export type BandVoice =
  | 'click'
  | 'kick'
  | 'snare'
  | 'hihat'
  | 'crash'
  | 'shaker'
  | 'tambourine'
  | 'keys'
  | 'lead';

export interface BandEvent {
  readonly voice: BandVoice;
  /** Offset into the beat (`0 ≤ offset < 1`). */
  readonly offsetBeats: number;
  /** Relative loudness (`0..1`); the engine maps it to each voice's level. */
  readonly level: number;
  /** For `click`: which click sound. */
  readonly click?: 'downbeat' | 'quarter' | 'subdivision';
  /** For `keys` / `lead`: semitones above the root. */
  readonly semitones?: readonly number[];
  /** For `keys` / `lead`: note length in beats. */
  readonly durationBeats?: number;
}

export const MAX_BAND_LEVEL = 5;
export const BAND_LEVEL_NAMES = ['Click', 'Drums', 'Hi-hats', 'Percussion', 'Keys', 'Hook'] as const;

/**
 * Two-bar hook in minor pentatonic around the root, as [beat in phrase, offset, semitones, beats].
 * Bar A rises, bar B answers and comes home.
 */
const HOOK: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 12, 0.5],
  [0, 0.5, 15, 0.5],
  [1, 0.5, 17, 0.5],
  [2, 0.5, 15, 1],
  [4, 0.5, 19, 0.5],
  [5, 0, 17, 0.5],
  [5, 0.5, 15, 0.5],
  [6, 0, 12, 1.5],
];

export function bandBeatEvents(opts: {
  /** Band layer `0..MAX_BAND_LEVEL`. */
  readonly level: number;
  readonly beatInBar: number;
  readonly beatsPerBar: number;
  /** Bar index within the current section (for the two-bar hook). */
  readonly phraseBar: number;
  /** Sparse placements thin the band out (Ghost road). */
  readonly placement: ClickPlacementMode;
  readonly silent: boolean;
  /** Last beat of this bar plays a drum fill (a change is coming). */
  readonly fill: boolean;
  /** First beat of a new section: crash. */
  readonly crash: boolean;
}): BandEvent[] {
  const { level, beatInBar, beatsPerBar, placement } = opts;
  if (opts.silent) {
    return [];
  }
  const lastBeat = beatInBar === beatsPerBar - 1;
  if (opts.fill && lastBeat) {
    return [
      { voice: 'kick', offsetBeats: 0, level: 0.8 },
      { voice: 'snare', offsetBeats: 0, level: 0.45 },
      { voice: 'snare', offsetBeats: 0.25, level: 0.6 },
      { voice: 'snare', offsetBeats: 0.5, level: 0.75 },
      { voice: 'snare', offsetBeats: 0.75, level: 0.95 },
    ];
  }

  const isBackbeat = beatInBar % 2 === 1;
  const events: BandEvent[] = [];

  if (level <= 0) {
    // Plain click, following the placement.
    const click = beatInBar === 0 ? 'downbeat' : 'quarter';
    if (placement === 'all' || placement === 'beats') {
      events.push({ voice: 'click', offsetBeats: 0, level: 1, click });
    } else if (placement === 'backbeat-2-4' && isBackbeat) {
      events.push({ voice: 'click', offsetBeats: 0, level: 1, click: 'quarter' });
    } else if (placement === 'one-drop-1' && beatInBar === 0) {
      events.push({ voice: 'click', offsetBeats: 0, level: 1, click: 'downbeat' });
    } else if (placement === 'offbeat-and') {
      events.push({ voice: 'click', offsetBeats: 0.5, level: 1, click: 'subdivision' });
    }
    return events;
  }

  // Sparse placements keep only the essential voice of the band.
  if (placement === 'backbeat-2-4') {
    if (isBackbeat) {
      events.push({ voice: 'snare', offsetBeats: 0, level: 1 });
      if (level >= 3) events.push({ voice: 'tambourine', offsetBeats: 0, level: 0.7 });
      if (level >= 4) events.push({ voice: 'keys', offsetBeats: 0, level: 0.8, semitones: [0, 7, 12], durationBeats: 0.3 });
    }
    return events;
  }
  if (placement === 'one-drop-1') {
    if (beatInBar === 0) {
      events.push({ voice: 'kick', offsetBeats: 0, level: 1 });
      if (level >= 4) events.push({ voice: 'keys', offsetBeats: 0, level: 0.8, semitones: [0, 7, 12], durationBeats: 0.5 });
    }
    return events;
  }
  if (placement === 'offbeat-and') {
    events.push({ voice: 'hihat', offsetBeats: 0.5, level: 0.9 });
    return events;
  }

  // Full band.
  if (opts.crash && beatInBar === 0) {
    events.push({ voice: 'crash', offsetBeats: 0, level: 0.8 });
  }
  if (beatInBar % 2 === 0) {
    events.push({ voice: 'kick', offsetBeats: 0, level: 1 });
  } else {
    events.push({ voice: 'snare', offsetBeats: 0, level: 1 });
  }
  if (level === 1) {
    events.push({ voice: 'hihat', offsetBeats: 0, level: 0.6 });
  }
  if (level >= 2) {
    events.push({ voice: 'hihat', offsetBeats: 0, level: 0.75 });
    events.push({ voice: 'hihat', offsetBeats: 0.5, level: 0.55 });
    if (beatInBar === 1) events.push({ voice: 'snare', offsetBeats: 0.75, level: 0.18 });
  }
  if (level >= 3) {
    for (const off of [0, 0.25, 0.5, 0.75]) {
      events.push({ voice: 'shaker', offsetBeats: off, level: off === 0 || off === 0.5 ? 0.7 : 0.45 });
    }
    if (isBackbeat) events.push({ voice: 'tambourine', offsetBeats: 0, level: 0.8 });
  }
  if (level >= 4 && isBackbeat) {
    events.push({ voice: 'keys', offsetBeats: 0, level: 0.8, semitones: [0, 7, 12, 15], durationBeats: 0.35 });
  }
  if (level >= 5) {
    const beatInPhrase = (opts.phraseBar % 2) * beatsPerBar + beatInBar;
    for (const [beat, offset, semitones, durationBeats] of HOOK) {
      if (beat === beatInPhrase) {
        events.push({ voice: 'lead', offsetBeats: offset, level: 0.8, semitones: [semitones], durationBeats });
      }
    }
  }
  return events;
}
