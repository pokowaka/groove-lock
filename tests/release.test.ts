import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BassOnsetAnalyzer } from '../src/dsp/onset';
import { type ReleaseEvent, ReleaseTracker } from '../src/dsp/release';

/** Feeds a synthetic envelope (dB over time) to a tracker, one frame per 2.67 ms. */
function run(tracker: ReleaseTracker, fromSec: number, toSec: number, dbAt: (t: number) => number): ReleaseEvent[] {
  const out: ReleaseEvent[] = [];
  const step = 128 / 48000;
  for (let t = fromSec; t < toSec; t += step) {
    const r = tracker.processEnvelope(10 ** (dbAt(t) / 20), t);
    if (r) out.push(r);
  }
  return out;
}

describe('ReleaseTracker', () => {
  it('finds a mute: a fast fall that stays down', () => {
    const tracker = new ReleaseTracker();
    tracker.noteOn(0);
    // Sustain at -10 dB, muted at 0.3 s (falls 0.4 dB/ms).
    const events = run(tracker, 0, 0.6, (t) => (t < 0.3 ? -10 : Math.max(-70, -10 - (t - 0.3) * 400)));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('muted');
    expect(events[0].releaseTimeSec).toBeGreaterThan(0.295);
    expect(events[0].releaseTimeSec).toBeLessThan(0.32);
  });

  it('does not mistake natural decay for a release; the next note ends it', () => {
    const tracker = new ReleaseTracker();
    tracker.noteOn(0);
    // A held low note: -10 dB decaying 1 dB per 100 ms.
    expect(run(tracker, 0, 1.5, (t) => -10 - t * 10)).toHaveLength(0);
    const cut = tracker.noteOn(1.5);
    expect(cut).toEqual({ onsetTimeSec: 0, releaseTimeSec: 1.5, kind: 'next-note' });
  });

  it('ignores a brief dip inside a note', () => {
    const tracker = new ReleaseTracker();
    tracker.noteOn(0);
    const dip = (t: number): number => (t > 0.1 && t < 0.13 ? -25 : -10);
    expect(run(tracker, 0, 0.5, dip)).toHaveLength(0);
  });

  it('ends a note left ringing once it has faded far below its peak', () => {
    const tracker = new ReleaseTracker();
    tracker.noteOn(0);
    const events = run(tracker, 0, 5, (t) => -5 - t * 10);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('faded');
    expect(events[0].releaseTimeSec).toBeCloseTo(3, 1);
  });

  it('corrects for the envelope lag', () => {
    const tracker = new ReleaseTracker(0.016);
    tracker.noteOn(0);
    const events = run(tracker, 0, 0.6, (t) => (t < 0.3 ? -10 : -10 - (t - 0.3) * 400));
    expect(events[0].releaseTimeSec).toBeLessThan(0.3);
  });
});

function readMonoWav16(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sampleRate = view.getUint32(24, true);
  let offset = 12;
  while (offset < buf.byteLength - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') {
      const samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return { samples, sampleRate };
    }
    offset += 8 + size;
  }
  throw new Error(`no data chunk in ${path}`);
}

/**
 * Real Scarlett recordings of staccato quarters. Ground truth: where each note's per-cycle peak
 * amplitude first falls 6 dB below its sustain level (measured from the waveforms).
 */
const cases: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['scarlett-e1-staccato-clipped', [0.54, 1.362, 2.122, 2.876]],
  ['scarlett-a1-staccato', [0.592, 1.358, 2.086, 2.884]],
  ['scarlett-e1-clipped-ripple', [0.392, 1.15, 4.948, 5.76, 6.556, 7.346]],
];

describe('BassOnsetAnalyzer — note releases on real recordings', () => {
  it.each(cases)('%s: one muted release per note, within 15 ms of the waveform', (name, truth) => {
    const { samples, sampleRate } = readMonoWav16(`tests/fixtures/${name}.wav`);
    const silent = new Float32Array(128);
    const analyzer = new BassOnsetAnalyzer();
    analyzer.setConfig({ channelMode: 'auto', onsetThreshold: 0.035, instrumentRange: 'bass' });
    const releases: ReleaseEvent[] = [];
    for (let offset = 0; offset + 128 <= samples.length; offset += 128) {
      const res = analyzer.processBlock(samples.subarray(offset, offset + 128), silent, offset / sampleRate, sampleRate);
      releases.push(...res.completedReleases);
    }
    expect(releases.map((r) => r.kind)).toEqual(truth.map(() => 'muted'));
    releases.forEach((r, i) => {
      expect(Math.abs(r.releaseTimeSec - truth[i])).toBeLessThan(0.015);
    });
  });
});
