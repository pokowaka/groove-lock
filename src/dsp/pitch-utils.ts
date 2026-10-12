import type {
  FrequencyBounds,
  InstrumentRange,
  NoteClass,
  PitchEstimate,
} from './types';

/**
 * Chromatic pitch classes ordered from `C` (MIDI % 12 === 0) to `B` (MIDI % 12 === 11).
 */
export const NOTE_NAMES: readonly NoteClass[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

/**
 * Standard bass/guitar Circle of Fourths root note progression starting from open `E`.
 */
export const FOURTHS_CYCLE: readonly NoteClass[] = [
  'E',
  'A',
  'D',
  'G',
  'C',
  'F',
  'A#',
  'D#',
  'G#',
  'C#',
  'F#',
  'B',
];

/**
 * Standard MIDI note numbers for a 4-string bass in 1st position (E1 = MIDI 28 through D#2 = MIDI 39).
 */
const BASS_FIRST_POSITION_MIDI: Readonly<Record<NoteClass, number>> = {
  E: 28, // E1 = 41.20 Hz
  F: 29, // F1 = 43.65 Hz
  'F#': 30, // F#1 = 46.25 Hz
  G: 31, // G1 = 49.00 Hz
  'G#': 32, // G#1 = 51.91 Hz
  A: 33, // A1 = 55.00 Hz
  'A#': 34, // A#1 = 58.27 Hz
  B: 35, // B1 = 61.74 Hz
  C: 36, // C2 = 65.41 Hz
  'C#': 37, // C#2 = 69.30 Hz
  D: 38, // D2 = 73.42 Hz
  'D#': 39, // D#2 = 77.78 Hz
};

const BASS_ROOT_FRET_HINTS: Readonly<Record<NoteClass, string>> = {
  E: 'E-String Open (Fret 0)',
  F: 'E-String Fret 1',
  'F#': 'E-String Fret 2',
  G: 'E-String Fret 3',
  'G#': 'E-String Fret 4',
  A: 'A-String Open / E Fret 5',
  'A#': 'A-String Fret 1',
  B: 'A-String Fret 2',
  C: 'A-String Fret 3',
  'C#': 'A-String Fret 4',
  D: 'D-String Open / A Fret 5',
  'D#': 'D-String Fret 1',
};

const BASS_OCTAVE_FRET_HINTS: Readonly<Record<NoteClass, string>> = {
  E: 'D-String Fret 2 (Octave)',
  F: 'D-String Fret 3 (Octave)',
  'F#': 'D-String Fret 4 (Octave)',
  G: 'G-String Open / D Fret 5 (Octave)',
  'G#': 'G-String Fret 1 (Octave)',
  A: 'G-String Fret 2 (Octave)',
  'A#': 'G-String Fret 3 (Octave)',
  B: 'G-String Fret 4 (Octave)',
  C: 'G-String Fret 5 (Octave)',
  'C#': 'G-String Fret 6 (Octave)',
  D: 'G-String Fret 7 (Octave)',
  'D#': 'G-String Fret 8 (Octave)',
};

/**
 * Pitch, frequency, and fretboard position metadata for a synthesized reference bass note.
 */
export interface BassVoiceNoteInfo {
  /** Concrete pitch class (`'E'`, `'A'`, etc.). */
  readonly noteClass: NoteClass;
  /** Scientific pitch notation with octave (`'E1'`, `'E2'`, `'A1'`, etc.). */
  readonly fullName: string;
  /** Fundamental frequency in Hz. */
  readonly freqHz: number;
  /** Recommended 4-string fretboard position hint (e.g. `'E-String Open (Fret 0)'`). */
  readonly fretboardHint: string;
}

/**
 * Returns the minimum and maximum fundamental frequencies (in Hz) searched by YIN
 * for the selected instrument filter.
 *
 * @param range `'bass'` (30–400 Hz), `'guitar'` (75–1100 Hz), or `'full'` (30–1200 Hz).
 */
export function getFrequencyBounds(range: InstrumentRange): FrequencyBounds {
  switch (range) {
    case 'bass':
      return { minFreqHz: 30, maxFreqHz: 400 };
    case 'guitar':
      return { minFreqHz: 75, maxFreqHz: 1100 };
    case 'full':
      return { minFreqHz: 30, maxFreqHz: 1200 };
  }
}

/**
 * Returns full pitch, octave, frequency, and fretboard position details for a
 * reference bass note.
 *
 * @param note Target pitch class or `'ANY'` (defaults to `'E'`).
 * @param range Instrument range (`'guitar'` shifts up 1 octave to E2–D#3).
 * @param octaveOffset Additional octave shift (`0` for root, `1` for octave pop).
 */
export function describeBassVoiceNote(
  note: NoteClass | 'ANY',
  range: InstrumentRange = 'bass',
  octaveOffset = 0,
): BassVoiceNoteInfo {
  const noteClass: NoteClass = note === 'ANY' ? 'E' : note;
  const baseMidi = BASS_FIRST_POSITION_MIDI[noteClass];
  const rangeOctaveShift = range === 'guitar' ? 12 : 0;
  const midi = baseMidi + rangeOctaveShift + octaveOffset * 12;
  const freqHz = 440 * Math.pow(2, (midi - 69) / 12);
  const octave = Math.floor(midi / 12) - 1;
  const fretboardHint =
    octaveOffset > 0
      ? BASS_OCTAVE_FRET_HINTS[noteClass]
      : BASS_ROOT_FRET_HINTS[noteClass];

  return {
    noteClass,
    fullName: `${noteClass}${octave}`,
    freqHz,
    fretboardHint,
  };
}

/**
 * Converts a target `NoteClass` (or `'ANY'`, which defaults to `'E'`) into its
 * fundamental frequency in Hz for the synthesized reference bass voice.
 *
 * @param note Target pitch class or `'ANY'`.
 * @param range Instrument range (`'guitar'` shifts up 1 octave to E2–D#3).
 * @param octaveOffset Additional octave shift (e.g. `1` for disco/funk octave pops).
 */
export function noteClassToBassFrequencyHz(
  note: NoteClass | 'ANY',
  range: InstrumentRange = 'bass',
  octaveOffset = 0,
): number {
  return describeBassVoiceNote(note, range, octaveOffset).freqHz;
}

/**
 * Converts a fundamental frequency in Hz into a 12-TET `PitchEstimate`
 * (A4 = 440 Hz reference, MIDI note 69).
 *
 * @param freqHz Detected fundamental frequency in Hz.
 * @param confidence Periodicity confidence score in `[0, 1]`.
 */
export function frequencyToPitchEstimate(
  freqHz: number,
  confidence = 1.0,
): PitchEstimate {
  const midiFloat = 69 + 12 * Math.log2(freqHz / 440);
  const midiNearest = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midiNearest) * 100);
  const noteIndex = ((midiNearest % 12) + 12) % 12;
  const noteClass = NOTE_NAMES[noteIndex];
  const octave = Math.floor(midiNearest / 12) - 1;

  return {
    freqHz,
    noteClass,
    octave,
    fullName: `${noteClass}${octave}`,
    cents,
    confidence,
  };
}
