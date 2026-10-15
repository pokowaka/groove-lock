import { describe, expect, it } from 'vitest';
import type { RecordedPcmChunk } from '../src/audio/audio-engine';
import {
  assembleTrack,
  encodeWav,
  encodeWavChannels,
  median,
  mixGains,
  normalizePeak,
  concatSamples,
} from '../src/audio/take';

function chunk(
  inputTimeSec: number,
  samples: number[],
  clockOffsetSec = 0,
  sampleRate = 10,
): RecordedPcmChunk {
  return { inputTimeSec, clockOffsetSec, sampleRate, samples: Float32Array.from(samples) };
}

describe('concatSamples', () => {
  it('joins parts with silence between them', () => {
    const out = concatSamples([new Float32Array([1, 2]), new Float32Array([3])], 2);
    expect(Array.from(out)).toEqual([1, 2, 0, 0, 3]);
  });

  it('treats a missing part as silence of the given length', () => {
    const out = concatSamples([new Float32Array([1]), { silence: 2 }], 1);
    expect(Array.from(out)).toEqual([1, 0, 0, 0]);
  });
});

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a value');
  return value;
}

describe('assembleTrack', () => {
  it('places chunks on the output timeline using the clock offset', () => {
    // 10 Hz sample rate keeps the arithmetic readable: 1 sample = 0.1 s.
    const track = must(assembleTrack([chunk(0.0, [1, 2]), chunk(0.2, [3, 4])].map((c) => ({ ...c, clockOffsetSec: 1.0 })), {
      startSec: 1.0,
      endSec: 1.6,
      shiftSec: 0,
    }));
    expect(track.sampleRate).toBe(10);
    expect(Array.from(track.data)).toEqual([1, 2, 3, 4, 0, 0]);
  });

  it('shifts by the latency compensation so audio lines up with grading', () => {
    const track = must(assembleTrack([chunk(0.3, [5, 6], 0)], { startSec: 0, endSec: 0.5, shiftSec: -0.1 }));
    expect(Array.from(track.data)).toEqual([0, 0, 5, 6, 0]);
  });

  it('uses the median clock offset to ignore jittery measurements', () => {
    const chunks = [chunk(0.0, [1], 1.0), chunk(0.1, [2], 1.0), chunk(0.2, [3], 1.03)];
    const track = must(assembleTrack(chunks, { startSec: 1.0, endSec: 1.3, shiftSec: 0 }));
    expect(Array.from(track.data)).toEqual([1, 2, 3]);
  });

  it('clips audio outside the window', () => {
    const track = must(assembleTrack([chunk(-0.1, [9, 1, 2]), chunk(0.2, [3, 4, 5])], {
      startSec: 0,
      endSec: 0.4,
      shiftSec: 0,
    }));
    expect(Array.from(track.data)).toEqual([1, 2, 3, 4]);
  });

  it('returns null without chunks', () => {
    expect(assembleTrack([], { startSec: 0, endSec: 1, shiftSec: 0 })).toBeNull();
  });
});

describe('normalizePeak', () => {
  it('scales quiet audio up to the target peak', () => {
    const data = Float32Array.from([0.1, -0.2, 0.05]);
    const gain = normalizePeak(data, 0.8, 10);
    expect(gain).toBeCloseTo(4);
    expect(data[1]).toBeCloseTo(-0.8);
  });

  it('limits the boost so near-silence is not amplified into noise', () => {
    const data = Float32Array.from([0.001, -0.002]);
    expect(normalizePeak(data, 0.8, 8)).toBe(8);
  });

  it('leaves silence untouched', () => {
    const data = new Float32Array(4);
    expect(normalizePeak(data, 0.8, 8)).toBe(1);
  });
});

describe('mixGains', () => {
  it('maps playback modes to drum and bass gains', () => {
    expect(mixGains('mix')).toEqual({ drums: 0.8, bass: 1 });
    expect(mixGains('bass')).toEqual({ drums: 0, bass: 1 });
    expect(mixGains('drums')).toEqual({ drums: 1, bass: 0 });
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM WAV', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 0.5]), 48000);
    const view = new DataView(wav);
    const text = (offset: number) =>
      String.fromCharCode(...new Uint8Array(wav, offset, 4));
    expect(text(0)).toBe('RIFF');
    expect(text(8)).toBe('WAVE');
    expect(text(12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(44 + 8);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(32767);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(16384);
  });

  it('clamps out-of-range samples', () => {
    const view = new DataView(encodeWav(Float32Array.from([2, -3]), 8000));
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});

describe('encodeWavChannels', () => {
  it('interleaves multiple channels', () => {
    const wav = encodeWavChannels([Float32Array.from([1, 0]), Float32Array.from([-1, 0.5])], 44100);
    const view = new DataView(wav);
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(28, true)).toBe(44100 * 4); // byte rate
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint32(40, true)).toBe(8); // 2 frames x 2 channels x 2 bytes
    expect(view.getInt16(44, true)).toBe(32767); // L0
    expect(view.getInt16(46, true)).toBe(-32768); // R0
    expect(view.getInt16(48, true)).toBe(0); // L1
    expect(view.getInt16(50, true)).toBe(16384); // R1
  });

  it('pads shorter channels with silence', () => {
    const wav = encodeWavChannels([Float32Array.from([0.5, 0.5]), Float32Array.from([0.5])], 8000);
    expect(new DataView(wav).getInt16(50, true)).toBe(0);
  });
});
