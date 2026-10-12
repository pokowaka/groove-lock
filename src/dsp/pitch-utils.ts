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
