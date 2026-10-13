import { describe, expect, it } from 'vitest';
import { LoopbackPingDetector } from '../src/dsp/loopback';
import { BassOnsetAnalyzer } from '../src/dsp/onset';
import { frequencyToPitchEstimate } from '../src/dsp/pitch-utils';
import type { DetectedPluckEvent, LoopbackSummary } from '../src/dsp/types';
import { detectPitchYINFromLinear, YIN_WINDOW_SIZE } from '../src/dsp/yin';

const SAMPLE_RATE = 48000;
const BLOCK_SIZE = 128;

/**
 * Generates a realistic bass string waveform with:
 * - High-frequency pluck transient burst in the first 8ms
 * - Fundamental + 2nd & 3rd harmonics with slight inharmonic beating
 * - Exponential amplitude decay
 */
function synthesizeBassPluck(
  buffer: Float32Array,
  startSample: number,
  durationSamples: number,
  fundamentalHz: number,
  amplitude: number,
): void {
  const endSample = Math.min(buffer.length, startSample + durationSamples);
  for (let i = startSample; i < endSample; i++) {
    const n = i - startSample;
    const tSec = n / SAMPLE_RATE;

    // Slow sustain decay (tau = 1.4s) + slight harmonic beating at 4.5 Hz
    const beatMod = 1 + 0.14 * Math.sin(2 * Math.PI * 4.5 * tSec);
    const sustainEnv = amplitude * Math.exp(-tSec / 1.4) * beatMod;

    // Initial string-pluck transient click (decays in ~5ms)
    const transientEnv = amplitude * 0.65 * Math.exp(-tSec / 0.004);
    const transientWave =
      transientEnv * Math.sin(2 * Math.PI * 1950 * tSec + 0.3);

    const f1 = Math.sin(2 * Math.PI * fundamentalHz * tSec);
    const f2 = 0.45 * Math.sin(2 * Math.PI * fundamentalHz * 2 * tSec + 0.4);
    const f3 = 0.2 * Math.sin(2 * Math.PI * fundamentalHz * 3 * tSec + 1.1);

    buffer[i] += sustainEnv * (f1 + f2 + f3) + transientWave;
  }
}

describe('YIN Pitch Detection & Pitch Math', () => {
  it('converts exact frequencies to note classes, octaves, and cents', () => {
    const e1 = frequencyToPitchEstimate(41.2034, 0.98);
    expect(e1.noteClass).toBe('E');
    expect(e1.octave).toBe(1);
    expect(e1.fullName).toBe('E1');
    expect(Math.abs(e1.cents)).toBeLessThanOrEqual(1);

    const a4Sharp = frequencyToPitchEstimate(445.1, 0.95);
    expect(a4Sharp.fullName).toBe('A4');
    expect(a4Sharp.cents).toBeGreaterThan(15);
    expect(a4Sharp.cents).toBeLessThan(25);
  });

  it('accurately detects 4-string and 5-string bass fundamentals (E1, A1, D2, G2)', () => {
    const testNotes: Array<{ name: string; freq: number }> = [
      { name: 'E1', freq: 41.203 },
      { name: 'A1', freq: 55.0 },
      { name: 'D2', freq: 73.416 },
      { name: 'G2', freq: 97.999 },
    ];

    for (const target of testNotes) {
      const window = new Float32Array(YIN_WINDOW_SIZE);
      for (let i = 0; i < YIN_WINDOW_SIZE; i++) {
        const t = i / SAMPLE_RATE;
        window[i] =
          0.35 * Math.sin(2 * Math.PI * target.freq * t) +
          0.12 * Math.sin(2 * Math.PI * target.freq * 2 * t);
      }

      const estimate = detectPitchYINFromLinear(window, SAMPLE_RATE, 'bass');
      expect(estimate).not.toBeNull();
      expect(estimate?.fullName).toBe(target.name);
      expect(Math.abs((estimate?.freqHz ?? 0) - target.freq)).toBeLessThan(0.6);
    }
  });
});

describe('BassOnsetAnalyzer — Open E1 Sustain Immunity & Re-Pluck Detection', () => {
  it('fires exactly 1 onset for a 3-second sustaining Open E1 (41.2 Hz) with zero false re-triggers', () => {
    const totalSeconds = 3.0;
    const totalSamples = Math.floor(totalSeconds * SAMPLE_RATE);
    const ch0 = new Float32Array(totalSamples);
    const ch1 = new Float32Array(totalSamples);

    // Pluck Open E1 (41.203 Hz) at t = 0.25s and let it ring for 2.75s
    const pluckStartSample = Math.floor(0.25 * SAMPLE_RATE);
    synthesizeBassPluck(
      ch0,
      pluckStartSample,
      totalSamples - pluckStartSample,
      41.203,
      0.22,
    );

    const analyzer = new BassOnsetAnalyzer();
    analyzer.setConfig({
      channelMode: 'auto',
      onsetThreshold: 0.035,
      instrumentRange: 'bass',
    });

    const detectedEvents: DetectedPluckEvent[] = [];

    for (let offset = 0; offset + BLOCK_SIZE <= totalSamples; offset += BLOCK_SIZE) {
      const block0 = ch0.subarray(offset, offset + BLOCK_SIZE);
      const block1 = ch1.subarray(offset, offset + BLOCK_SIZE);
      const blockTimeSec = offset / SAMPLE_RATE;

      const res = analyzer.processBlock(block0, block1, blockTimeSec, SAMPLE_RATE);
      detectedEvents.push(...res.completedPlucks);
    }

    expect(detectedEvents).toHaveLength(1);
    expect(detectedEvents[0].rawOnsetTimeSec).toBeGreaterThanOrEqual(0.248);
    expect(detectedEvents[0].rawOnsetTimeSec).toBeLessThanOrEqual(0.26);
    expect(detectedEvents[0].pitch?.fullName).toBe('E1');
  });

  it('detects a second pluck on a ringing bass string (E1 -> A1)', () => {
    const totalSeconds = 2.2;
    const totalSamples = Math.floor(totalSeconds * SAMPLE_RATE);
    const ch0 = new Float32Array(totalSamples);
    const ch1 = new Float32Array(totalSamples);

    // First pluck: E1 at t = 0.20s
    const firstPluckSample = Math.floor(0.2 * SAMPLE_RATE);
    const secondPluckSample = Math.floor(1.0 * SAMPLE_RATE);

    synthesizeBassPluck(
      ch0,
      firstPluckSample,
      secondPluckSample - firstPluckSample,
      41.203,
      0.2,
    );
    // Second pluck: A1 (55 Hz) at t = 1.00s while E1 has decayed partway
    synthesizeBassPluck(
      ch0,
      secondPluckSample,
      totalSamples - secondPluckSample,
      55.0,
      0.26,
    );

    const analyzer = new BassOnsetAnalyzer();
    analyzer.setConfig({
      channelMode: '0',
      onsetThreshold: 0.035,
      instrumentRange: 'bass',
    });

    const detectedEvents: DetectedPluckEvent[] = [];
    for (let offset = 0; offset + BLOCK_SIZE <= totalSamples; offset += BLOCK_SIZE) {
      const block0 = ch0.subarray(offset, offset + BLOCK_SIZE);
      const block1 = ch1.subarray(offset, offset + BLOCK_SIZE);
      const res = analyzer.processBlock(
        block0,
        block1,
        offset / SAMPLE_RATE,
        SAMPLE_RATE,
      );
      detectedEvents.push(...res.completedPlucks);
    }

    expect(detectedEvents).toHaveLength(2);
    expect(detectedEvents[0].pitch?.fullName).toBe('E1');
    expect(detectedEvents[1].pitch?.fullName).toBe('A1');
    expect(detectedEvents[1].rawOnsetTimeSec).toBeGreaterThanOrEqual(0.995);
    expect(detectedEvents[1].rawOnsetTimeSec).toBeLessThanOrEqual(1.015);
  });
});

function runLoopback(
  emitTimesSec: number[],
  simulatedRtlMs: number,
  totalSec: number,
): LoopbackSummary | null {
  const totalSamples = Math.floor(totalSec * SAMPLE_RATE);
  const stream = new Float32Array(totalSamples);

  // Add tiny ambient noise floor
  for (let i = 0; i < totalSamples; i++) {
    stream[i] = 0.0002 * Math.sin(i * 0.3);
  }

  // Inject returning 1760 Hz sonar bursts at emitTime + RTL
  for (const emitSec of emitTimesSec) {
    const arrivalSample = Math.round((emitSec + simulatedRtlMs / 1000) * SAMPLE_RATE);
    const burstSamples = Math.floor(0.012 * SAMPLE_RATE);
    for (let k = 0; k < burstSamples; k++) {
      const idx = arrivalSample + k;
      if (idx < totalSamples) {
        stream[idx] =
          0.35 *
          Math.exp(-k / (0.004 * SAMPLE_RATE)) *
          Math.sin((2 * Math.PI * 1760 * k) / SAMPLE_RATE);
      }
    }
  }

  const detector = new LoopbackPingDetector();
  detector.start(emitTimesSec);
  for (let offset = 0; offset + BLOCK_SIZE <= totalSamples; offset += BLOCK_SIZE) {
    const block = stream.subarray(offset, offset + BLOCK_SIZE);
    const res = detector.processBlock(block, offset / SAMPLE_RATE, SAMPLE_RATE);
    if (res) {
      return res;
    }
  }
  return null;
}

describe('LoopbackPingDetector — Sample-Accurate Hardware RTL', () => {
  it('measures exact round-trip latency median across 6 sonar pings', () => {
    const simulatedRtlMs = 19.5; // 19.5ms hardware round-trip delay
    const summary = runLoopback([0.2, 0.5, 0.8, 1.1, 1.4, 1.7], simulatedRtlMs, 2.4);
    expect(summary).not.toBeNull();
    expect(summary?.success).toBe(true);
    expect(summary?.detectedCount).toBe(6);
    expect(summary?.medianRtlMs).not.toBeNull();
    expect(Math.abs((summary?.medianRtlMs ?? 0) - simulatedRtlMs)).toBeLessThan(0.5);
  });

  it('measures large round-trip latencies (e.g. 250 ms) with pings spaced 600 ms apart', () => {
    const emitTimesSec = [0.2, 0.8, 1.4, 2.0, 2.6, 3.2];
    const summary = runLoopback(emitTimesSec, 250, 4.0);
    expect(summary?.success).toBe(true);
    expect(summary?.detectedCount).toBe(6);
    expect(Math.abs((summary?.medianRtlMs ?? 0) - 250)).toBeLessThan(0.5);
  });
});
