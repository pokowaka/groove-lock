import { frequencyToPitchEstimate, getFrequencyBounds } from './pitch-utils';
import type { InstrumentRange, PitchEstimate } from './types';

/**
 * Total number of contiguous samples unwrapped for a single YIN pitch evaluation.
 *
 * At 48 kHz, 3,072 samples spans 64.0 ms:
 * - Large enough to contain a 1,360-sample integration window plus a 1,660-sample
 *   maximum lag (`tauMax`), enabling fundamental detection down to 28.9 Hz
 *   (covering 5-string bass low B0 = 30.87 Hz and 4-string bass E1 = 41.20 Hz).
 * - Compact enough to fit completely inside the post-attack settle window (65 ms)
 *   so pre-pluck silence or previous note bleed does not pollute autocorrelation.
 */
export const YIN_WINDOW_SIZE = 3072;

/**
 * Unwraps the most recent `outLinear.length` samples from a power-of-two circular
 * ring buffer into a contiguous linear `Float32Array` ordered oldest-to-newest.
 *
 * @param ringBuffer Power-of-two circular sample buffer (e.g. 4096 samples).
 * @param writeIndex Next write index in `ringBuffer`.
 * @param outLinear Destination linear buffer of length `<= ringBuffer.length`.
 */
export function unwrapRingBuffer(
  ringBuffer: Float32Array,
  writeIndex: number,
  outLinear: Float32Array,
): void {
  const mask = ringBuffer.length - 1;
  const len = outLinear.length;
  let readIdx = (writeIndex - len + ringBuffer.length) & mask;
  for (let i = 0; i < len; i++) {
    outLinear[i] = ringBuffer[readIdx];
    readIdx = (readIdx + 1) & mask;
  }
}

/**
 * Time-domain YIN autocorrelation pitch detector (de Cheveigné & Kawahara, 2002).
 *
 * Computes the Cumulative Mean Normalized Difference Function (CMNDF) across
 * candidate lag periods `tau` bounded by `range`, locates the first deep minimum
 * below `yinThreshold`, and refines the period estimate via parabolic interpolation
 * for sub-sample frequency and cents precision.
 *
 * @param samples Contiguous time-domain audio samples (at least `YIN_WINDOW_SIZE` long).
 * @param sampleRate Audio hardware sample rate in Hz (typically 48000 or 44100).
 * @param range Frequency bounds preset (`'bass'`, `'guitar'`, or `'full'`).
 * @param yinThreshold Aperiodicity threshold for fundamental lock (default `0.16`).
 * @returns A `PitchEstimate` with frequency, MIDI note name, cents offset, and confidence,
 *          or `null` if the signal is percussive/muted or outside the target frequency range.
 */
export function detectPitchYINFromLinear(
  samples: Float32Array,
  sampleRate: number,
  range: InstrumentRange = 'bass',
  yinThreshold = 0.16,
): PitchEstimate | null {
  if (samples.length < YIN_WINDOW_SIZE) {
    return null;
  }

  const { minFreqHz, maxFreqHz } = getFrequencyBounds(range);
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreqHz));
  const tauMax = Math.min(
    Math.floor(samples.length * 0.54),
    Math.ceil(sampleRate / minFreqHz),
  );
  const integrationWindow = samples.length - tauMax - 1;
  if (integrationWindow <= 64 || tauMax <= tauMin) {
    return null;
  }

  const yinBuffer = new Float32Array(tauMax + 1);
  yinBuffer[0] = 1;
  let runningSum = 0;

  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < integrationWindow; i++) {
      const delta = samples[i] - samples[i + tau];
      sum += delta * delta;
    }
    runningSum += sum;
    yinBuffer[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;
  }

  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (yinBuffer[tau] < yinThreshold) {
      while (tau + 1 <= tauMax && yinBuffer[tau + 1] < yinBuffer[tau]) {
        tau++;
      }
      tauEstimate = tau;
      break;
    }
  }

  // Fallback to global minimum if below 0.32 aperiodicity threshold
  if (tauEstimate === -1) {
    let minVal = 0.32;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (yinBuffer[tau] < minVal) {
        minVal = yinBuffer[tau];
        tauEstimate = tau;
      }
    }
  }

  if (tauEstimate === -1) {
    return null;
  }

  const aperiodicity = yinBuffer[tauEstimate];
  let betterTau = tauEstimate;

  if (tauEstimate > 1 && tauEstimate < tauMax) {
    const s0 = yinBuffer[tauEstimate - 1];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[tauEstimate + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-6) {
      betterTau = tauEstimate + (s2 - s0) / denom;
    }
  }

  const freqHz = sampleRate / betterTau;
  if (freqHz < minFreqHz || freqHz > maxFreqHz) {
    return null;
  }

  const confidence = Math.max(0, Math.min(1, 1 - aperiodicity));
  return frequencyToPitchEstimate(freqHz, confidence);
}
