import { describe, expect, it } from 'vitest';
import type { DiagnosticPcmChunk } from '../src/audio/audio-engine';
import { placeDiagnosticChunks } from '../src/audio/diagnostics';

function chunk(inputTimeSec: number, ch0: number[], ch1: number[]): DiagnosticPcmChunk {
  return {
    inputTimeSec,
    clockOffsetSec: 0.5,
    sampleRate: 10,
    ch0: Float32Array.from(ch0),
    ch1: Float32Array.from(ch1),
  };
}

describe('placeDiagnosticChunks', () => {
  it('places both channels on the input clock, starting at the first chunk', () => {
    const placed = placeDiagnosticChunks([chunk(2.0, [1, 2], [5, 6]), chunk(2.2, [3], [7])]);
    expect(placed?.startInputTimeSec).toBe(2.0);
    expect(placed?.sampleRate).toBe(10);
    expect(Array.from(placed?.ch0 ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(placed?.ch1 ?? [])).toEqual([5, 6, 7]);
  });

  it('keeps gaps between chunks as silence so timing stays exact', () => {
    const placed = placeDiagnosticChunks([chunk(0, [1], [1]), chunk(0.3, [2], [2])]);
    expect(Array.from(placed?.ch0 ?? [])).toEqual([1, 0, 0, 2]);
  });

  it('returns null without audio', () => {
    expect(placeDiagnosticChunks([])).toBeNull();
  });
});
