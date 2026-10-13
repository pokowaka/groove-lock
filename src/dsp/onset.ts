import type {
  DetectedPluckEvent,
  InputChannelMode,
  InstrumentRange,
  PitchEstimate,
} from './types';
import {
  detectPitchYINFromLinear,
  unwrapRingBuffer,
  YIN_WINDOW_SIZE,
} from './yin';

/**
 * Size of the power-of-two circular sample history buffer (85.3 ms at 48 kHz).
 */
export const RING_BUFFER_SIZE = 4096;
const RING_BUFFER_MASK = RING_BUFFER_SIZE - 1;

/**
 * Number of samples integrated for the cycle-safe sustain envelope (32.0 ms at 48 kHz).
 *
 * Acoustic rationale:
 * A 128-sample Web Audio block is only 2.67 ms long, whereas a single cycle of an
 * open 4-string bass E1 string (41.20 Hz) is 24.3 ms (1,165 samples at 48 kHz).
 * Evaluating note release on a 128-sample block causes the envelope to drop near zero
 * every 12.1 ms as the bass sine wave crosses zero, causing false re-triggers.
 * Integrating over 1,536 samples (32 ms, >1.3 full cycles of E1) guarantees a smooth,
 * zero-crossing-immune envelope.
 */
const SUSTAIN_WINDOW_SAMPLES = 1536;

/**
 * Post-onset delay (66 ms) before running YIN pitch extraction.
 * Allows the noisy broadband fret/pick scrape transient to settle into a clean
 * periodic waveform and ensures the 3,072-sample (64 ms) YIN window contains
 * 100% post-pluck samples.
 */
const PITCH_SETTLE_DELAY_SEC = 0.066;

/**
 * A re-pluck on a ringing string must raise the cycle-integrated 32 ms envelope by at least this
 * factor (relative to just before the attack transient) within `RE_PLUCK_CONFIRM_SEC`.
 *
 * Rationale: the fast 128-sample block RMS swings with the waveform's phase on low notes (one E1
 * cycle is 24 ms), and clipped notes have sharp edges every cycle, so "block RMS jumped + HF spike"
 * alone fires false re-plucks ~150 ms into every ringing low note. A real new pluck adds energy,
 * which only the cycle-safe envelope can see reliably.
 */
const RE_PLUCK_ENV_RISE = 1.3;
const RE_PLUCK_CONFIRM_SEC = 0.045;
/**
 * Number of recent blocks (~43 ms at 48 kHz) whose peak sustain envelope serves as the re-pluck
 * baseline. Clipped low notes make even the 32 ms envelope ripple ±15% per cycle; comparing with
 * the recent peak (not the previous block, which may sit in a ripple dip) keeps that ripple from
 * looking like a rise.
 */
const RE_PLUCK_BASELINE_BLOCKS = 16;

interface PendingPitchJob {
  readonly rawOnsetTimeSec: number;
  readonly executeAtTimeSec: number;
  readonly peakRms: number;
}

/**
 * Result returned by `BassOnsetAnalyzer.processBlock` for each 128-sample audio quantum.
 */
export interface AudioBlockAnalysis {
  /** RMS amplitude of hardware Input 1 (`ch0`). */
  readonly rmsCh0: number;
  /** RMS amplitude of hardware Input 2 (`ch1`). */
  readonly rmsCh1: number;
  /** RMS amplitude of the selected/active instrument channel. */
  readonly activeRms: number;
  /** Highest absolute sample of the selected/active channel in this block. */
  readonly peakAbs: number;
  /** Pluck events whose post-onset YIN pitch evaluation completed during this block. */
  readonly completedPlucks: readonly DetectedPluckEvent[];
}

/**
 * Real-time two-stage bass & guitar onset and pitch analyzer designed to run inside
 * an `AudioWorkletProcessor` with zero heap allocations on the hot sample path.
 *
 * ### How It Works
 * 1. **Stage 1 (Sub-Millisecond Onset Detection):**
 *    - Tracks both the fast 128-sample block RMS (`activeRms`), a high-frequency
 *      first-difference transient metric (`hfRms` via $s[n] - s[n-1]$), and a slow
 *      32 ms (1,536-sample) cycle-integrated sustain envelope (`sustainEnv`).
 *    - Triggers an onset either from silence (`armedForOnset === true`) or via a
 *      re-pluck on an already-ringing string: a fresh high-frequency transient spike that is
 *      confirmed by a real rise of the cycle-safe 32 ms envelope within 45 ms (the onset keeps
 *      the transient's timestamp).
 * 2. **Stage 2 (Delayed YIN Pitch Lock):**
 *    - Schedules a `PendingPitchJob` for `rawOnsetTimeSec + 66 ms` so YIN evaluates
 *      the settled harmonic fundamental rather than the initial percussive attack.
 */
export class BassOnsetAnalyzer {
  private readonly ringBuffer = new Float32Array(RING_BUFFER_SIZE);
  private readonly linearScratch = new Float32Array(YIN_WINDOW_SIZE);
  private ringWriteIndex = 0;

  private channelMode: InputChannelMode = 'auto';
  private onsetThreshold = 0.035;
  private instrumentRange: InstrumentRange = 'bass';
  private readonly minInterOnsetSec = 0.13;

  private prevRms = 0;
  private prevSample = 0;
  private smoothHfRms = 0.001;
  private notePeakEnv = 0;
  private minSustainEnv = 0;
  private lastOnsetTimeSec = -10;
  private armedForOnset = true;
  /** Sustain envelope of the most recent blocks (ring buffer) for the re-pluck baseline. */
  private readonly recentSustainEnv = new Float32Array(RE_PLUCK_BASELINE_BLOCKS);
  private recentSustainIdx = 0;
  /** Time of a high-frequency attack transient on a ringing string awaiting envelope confirmation. */
  private pendingAttackTimeSec: number | null = null;
  /** Peak sustain envelope over the ~43 ms before that transient. */
  private pendingAttackEnv = 0;

  private readonly pendingJobs: PendingPitchJob[] = [];

  /**
   * Updates the channel routing mode, pluck sensitivity threshold, or instrument pitch filter.
   */
  public setConfig(config: {
    channelMode?: InputChannelMode;
    onsetThreshold?: number;
    instrumentRange?: InstrumentRange;
  }): void {
    if (config.channelMode !== undefined) {
      this.channelMode = config.channelMode;
    }
    if (config.onsetThreshold !== undefined) {
      this.onsetThreshold = config.onsetThreshold;
    }
    if (config.instrumentRange !== undefined) {
      this.instrumentRange = config.instrumentRange;
    }
  }

  /**
   * Returns the current RMS onset threshold.
   */
  public getOnsetThreshold(): number {
    return this.onsetThreshold;
  }

  /**
   * Processes a single audio block (typically 128 samples) from Input 1 (`ch0`) and Input 2 (`ch1`).
   *
   * @param ch0 Float32Array for hardware channel 0 (Scarlett 4th Gen Front 1/4" Hi-Z input).
   * @param ch1 Float32Array for hardware channel 1 (Scarlett 3rd Gen Front 1/4" Hi-Z input).
   * @param blockStartTimeSec `currentTime` in seconds at the start of this audio block.
   * @param sampleRate Audio context sample rate in Hz.
   * @param suppressOnsets When `true` (e.g. during loopback sonar calibration), skips pluck detection.
   */
  public processBlock(
    ch0: Float32Array,
    ch1: Float32Array,
    blockStartTimeSec: number,
    sampleRate: number,
    suppressOnsets = false,
  ): AudioBlockAnalysis {
    const len = ch0.length;

    let sumSq0 = 0;
    let sumSq1 = 0;
    for (let i = 0; i < len; i++) {
      sumSq0 += ch0[i] * ch0[i];
      sumSq1 += ch1[i] * ch1[i];
    }
    const rmsCh0 = Math.sqrt(sumSq0 / len);
    const rmsCh1 = Math.sqrt(sumSq1 / len);

    let activeChannel = ch0;
    if (this.channelMode === 'auto') {
      activeChannel = rmsCh0 >= rmsCh1 ? ch0 : ch1;
    } else if (this.channelMode === '1') {
      activeChannel = ch1;
    }

    let activeSumSq = 0;
    let hfDiffSumSq = 0;
    let peakAbs = 0;
    let firstPeakSampleIdx = 0;
    let prevS = this.prevSample;

    for (let i = 0; i < len; i++) {
      const s =
        this.channelMode === 'sum'
          ? 0.5 * (ch0[i] + ch1[i])
          : activeChannel[i];

      this.ringBuffer[this.ringWriteIndex] = s;
      this.ringWriteIndex = (this.ringWriteIndex + 1) & RING_BUFFER_MASK;

      const diff = s - prevS;
      hfDiffSumSq += diff * diff;
      prevS = s;

      const absS = Math.abs(s);
      activeSumSq += s * s;
      if (absS > peakAbs) {
        peakAbs = absS;
        firstPeakSampleIdx = i;
      }
    }

    this.prevSample = prevS;
    const activeRms = Math.sqrt(activeSumSq / len);
    const hfRms = Math.sqrt(hfDiffSumSq / len);

    // 32ms (1536-sample) cycle-integrated sustain envelope
    let sustainSumSq = 0;
    let rIdx =
      (this.ringWriteIndex - SUSTAIN_WINDOW_SAMPLES + RING_BUFFER_SIZE) &
      RING_BUFFER_MASK;
    for (let k = 0; k < SUSTAIN_WINDOW_SAMPLES; k += 2) {
      const val = this.ringBuffer[rIdx];
      sustainSumSq += val * val;
      rIdx = (rIdx + 2) & RING_BUFFER_MASK;
    }
    const sustainEnv = Math.sqrt(sustainSumSq / (SUSTAIN_WINDOW_SAMPLES / 2));

    const exactCandidateTimeSec =
      blockStartTimeSec + firstPeakSampleIdx / sampleRate;
    const timeSinceLastOnset = exactCandidateTimeSec - this.lastOnsetTimeSec;

    if (!this.armedForOnset) {
      if (sustainEnv > this.notePeakEnv) {
        this.notePeakEnv = sustainEnv;
        this.minSustainEnv = sustainEnv;
      } else if (timeSinceLastOnset > 0.065 && sustainEnv < this.minSustainEnv) {
        this.minSustainEnv = sustainEnv;
      }

      const releaseFloor = Math.min(
        this.onsetThreshold * 0.48,
        this.notePeakEnv * 0.28,
      );
      if (sustainEnv < releaseFloor) {
        this.armedForOnset = true;
        this.notePeakEnv = 0;
        this.minSustainEnv = 0;
        this.pendingAttackTimeSec = null;
      }
    }

    const fluxRatio = activeRms / (this.prevRms + 0.0001);
    const isFreshPluckFromSilence =
      this.armedForOnset &&
      activeRms >= this.onsetThreshold &&
      fluxRatio > 1.35;

    // On a ringing string, a new pluck shows up as a sharp high-frequency derivative spike
    // (s[n] - s[n-1]) from the finger/pick attack. Remember it, and confirm it only once the
    // cycle-safe 32 ms envelope has actually risen; the onset keeps the transient's timestamp.
    const isAttackTransient =
      hfRms > this.smoothHfRms * 2.1 &&
      hfRms > 0.0035 &&
      activeRms >= this.onsetThreshold;
    if (
      !this.armedForOnset &&
      this.pendingAttackTimeSec === null &&
      isAttackTransient &&
      timeSinceLastOnset >= 0.16
    ) {
      this.pendingAttackTimeSec = exactCandidateTimeSec;
      let recentPeak = 0;
      for (let k = 0; k < RE_PLUCK_BASELINE_BLOCKS; k++) {
        recentPeak = Math.max(recentPeak, this.recentSustainEnv[k]);
      }
      this.pendingAttackEnv = recentPeak;
    }

    let rePluckTimeSec: number | null = null;
    if (!this.armedForOnset && this.pendingAttackTimeSec !== null) {
      if (sustainEnv >= this.pendingAttackEnv * RE_PLUCK_ENV_RISE) {
        rePluckTimeSec = this.pendingAttackTimeSec;
        this.pendingAttackTimeSec = null;
      } else if (exactCandidateTimeSec - this.pendingAttackTimeSec > RE_PLUCK_CONFIRM_SEC) {
        this.pendingAttackTimeSec = null;
      }
    }

    const onsetTimeSec = isFreshPluckFromSilence ? exactCandidateTimeSec : rePluckTimeSec;
    if (
      !suppressOnsets &&
      onsetTimeSec !== null &&
      onsetTimeSec - this.lastOnsetTimeSec >= this.minInterOnsetSec
    ) {
      this.lastOnsetTimeSec = onsetTimeSec;
      this.armedForOnset = false;
      this.pendingAttackTimeSec = null;
      this.notePeakEnv = Math.max(activeRms, sustainEnv);
      this.minSustainEnv = this.notePeakEnv;

      this.pendingJobs.push({
        rawOnsetTimeSec: onsetTimeSec,
        executeAtTimeSec: onsetTimeSec + PITCH_SETTLE_DELAY_SEC,
        peakRms: activeRms,
      });
    }

    this.recentSustainEnv[this.recentSustainIdx] = sustainEnv;
    this.recentSustainIdx = (this.recentSustainIdx + 1) % RE_PLUCK_BASELINE_BLOCKS;
    this.prevRms = activeRms;
    this.smoothHfRms = 0.85 * this.smoothHfRms + 0.15 * hfRms;

    const blockEndTimeSec = blockStartTimeSec + len / sampleRate;
    const completedPlucks: DetectedPluckEvent[] = [];

    for (let j = 0; j < this.pendingJobs.length; ) {
      const job = this.pendingJobs[j];
      if (blockEndTimeSec >= job.executeAtTimeSec) {
        this.pendingJobs.splice(j, 1);
        const pitch = this.detectCurrentPitch(sampleRate);
        completedPlucks.push({
          rawOnsetTimeSec: job.rawOnsetTimeSec,
          pitch,
          peakRms: job.peakRms,
        });
      } else {
        j++;
      }
    }

    return {
      rmsCh0,
      rmsCh1,
      activeRms,
      peakAbs,
      completedPlucks,
    };
  }

  /**
   * Unwraps the latest `YIN_WINDOW_SIZE` (3,072) samples from the circular buffer
   * and runs YIN autocorrelation pitch detection.
   */
  public detectCurrentPitch(sampleRate: number): PitchEstimate | null {
    unwrapRingBuffer(this.ringBuffer, this.ringWriteIndex, this.linearScratch);
    return detectPitchYINFromLinear(
      this.linearScratch,
      sampleRate,
      this.instrumentRange,
    );
  }
}
