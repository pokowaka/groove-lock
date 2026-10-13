import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BassOnsetAnalyzer } from '../src/dsp/onset';
import type { DetectedPluckEvent } from '../src/dsp/types';

/**
 * Regression tests on real Scarlett Solo recordings (bass DI, 48 kHz, one bar of staccato quarter
 * notes at 78 BPM). Ground-truth attack times were measured directly from the waveforms.
 *
 * The E1 clip is hot enough to clip (peak 1.0). The detector used to fire a second, false "re-pluck"
 * ~150 ms into every ringing low note, which the grader then scored as +150..+230 ms LATE.
 */

function readMonoWav16(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sampleRate = view.getUint32(24, true);
  let offset = 12;
  while (offset < buf.byteLength - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const n = size / 2;
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    offset += 8 + size;
  }
  throw new Error(`no data chunk in ${path}`);
}

function detect(path: string): DetectedPluckEvent[] {
  const { samples, sampleRate } = readMonoWav16(path);
  const silent = new Float32Array(128);
  const analyzer = new BassOnsetAnalyzer();
  analyzer.setConfig({ channelMode: 'auto', onsetThreshold: 0.035, instrumentRange: 'bass' });
  const events: DetectedPluckEvent[] = [];
  for (let offset = 0; offset + 128 <= samples.length; offset += 128) {
    const block = samples.subarray(offset, offset + 128);
    const res = analyzer.processBlock(block, silent, offset / sampleRate, sampleRate);
    events.push(...res.completedPlucks);
  }
  return events;
}

const cases: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['scarlett-e1-staccato-clipped', [0.3746, 1.169, 1.9165, 2.6959]],
  ['scarlett-a1-staccato', [0.4065, 1.1538, 1.9185, 2.7]],
  // Clipped E1 notes whose 32 ms envelope ripples ±15% per cycle (used to leave 4 false re-plucks).
  ['scarlett-e1-clipped-ripple', [0.1468, 0.9271, 4.7269, 5.5382, 6.3337, 7.124]],
];

describe('BassOnsetAnalyzer — real Scarlett recordings', () => {
  it.each(cases)('%s: one onset per note, close to the true attack', (name, truth) => {
    const events = detect(`tests/fixtures/${name}.wav`);
    const times = events.map((e) => e.rawOnsetTimeSec);
    expect(times).toHaveLength(truth.length);
    times.forEach((t, i) => {
      // The detector lands a consistent 3–8 ms before the "20% of peak" waveform estimate. A
      // constant bias like this is absorbed by latency calibration, which uses the same detector.
      expect(Math.abs(t - truth[i]) * 1000).toBeLessThan(10);
    });
  });
});
