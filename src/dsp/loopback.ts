import type { LoopbackPulseResult, LoopbackSummary } from './types';

interface MutablePulseState {
  readonly emitTimeSec: number;
  leadingEdgeTimeSec: number | null;
  baselinePeak: number;
  maxPeak: number;
}

/**
 * Sample-accurate hardware loopback sonar ping detector.
 *
 * ### Calibration Procedure
 * When the user clicks **Auto-Ping Loopback**, `AudioEngine` schedules 6 short
 * 1760 Hz sine bursts on `outputCtx` and sends their translated `inputCtx` emission
 * timestamps to `LoopbackPingDetector.start()`.
 *
 * For each pulse $p$:
 * 1. **Ambient Noise Window (`[-45 ms, -2 ms]`):** Measures the peak background floor
 *    (`baselinePeak`) immediately preceding the pulse.
 * 2. **Detection Window (`[+1 ms, +125 ms]`):** Computes a dynamic trigger gate
 *    `max(0.0025, baselinePeak * 3.5)` and records the exact sample timestamp
 *    (`leadingEdgeTimeSec`) of the first sample that crosses the gate.
 * 3. **Median Aggregation:** Once the final pulse window closes (`emitTime + 140 ms`),
 *    computes the median round-trip latency (`medianRtlMs`) across all valid detections
 *    so any single outlier or string bump is rejected.
 */
export class LoopbackPingDetector {
  private pulses: MutablePulseState[] = [];
  private active = false;

  /**
   * Arms the detector with a sequence of scheduled ping emission timestamps (in `inputCtx` seconds).
   */
  public start(emitTimesSec: readonly number[]): void {
    this.pulses = emitTimesSec.map((emitTimeSec) => ({
      emitTimeSec,
      leadingEdgeTimeSec: null,
      baselinePeak: 0.0005,
      maxPeak: 0,
    }));
    this.active = this.pulses.length > 0;
  }

  /**
   * Cancels any in-progress loopback calibration session.
   */
  public stop(): void {
    this.active = false;
    this.pulses = [];
  }

  /**
   * Returns `true` while a loopback ping sequence is actively listening for return pulses.
   */
  public isActive(): boolean {
    return this.active;
  }

  /**
   * Scans a block of input samples and returns a `LoopbackSummary` once the final
   * pulse detection window completes (`lastPulse.emitTimeSec + 140 ms`).
   *
   * @param samples Active input channel samples for the current block.
   * @param blockStartTimeSec `currentTime` in seconds at the start of `samples`.
   * @param sampleRate Hardware sample rate in Hz.
   */
  public processBlock(
    samples: Float32Array,
    blockStartTimeSec: number,
    sampleRate: number,
  ): LoopbackSummary | null {
    if (!this.active || this.pulses.length === 0) {
      return null;
    }

    const len = samples.length;
    for (let i = 0; i < len; i++) {
      const absS = Math.abs(samples[i]);
      const sampleTimeSec = blockStartTimeSec + i / sampleRate;

      for (let p = 0; p < this.pulses.length; p++) {
        const pulse = this.pulses[p];
        const relSec = sampleTimeSec - pulse.emitTimeSec;

        if (relSec >= -0.045 && relSec < -0.002) {
          if (absS > pulse.baselinePeak) {
            pulse.baselinePeak = absS;
          }
        } else if (relSec >= 0.001 && relSec <= 0.125) {
          const triggerFloor = Math.max(0.0025, pulse.baselinePeak * 3.5);
          if (pulse.leadingEdgeTimeSec === null && absS >= triggerFloor) {
            pulse.leadingEdgeTimeSec = sampleTimeSec;
          }
          if (absS > pulse.maxPeak) {
            pulse.maxPeak = absS;
          }
        }
      }
    }

    const lastPulse = this.pulses[this.pulses.length - 1];
    const blockEndTimeSec = blockStartTimeSec + len / sampleRate;

    if (blockEndTimeSec > lastPulse.emitTimeSec + 0.14) {
      const summary = LoopbackPingDetector.summarize(this.pulses);
      this.stop();
      return summary;
    }

    return null;
  }

  /**
   * Computes the median round-trip latency (in ms) from a list of per-pulse results.
   * Requires at least 2 valid pulse detections within `[1 ms, 125 ms]`.
   */
  public static summarize(
    pulses: readonly LoopbackPulseResult[],
  ): LoopbackSummary {
    const validRtlsMs: number[] = [];

    for (const p of pulses) {
      if (p.leadingEdgeTimeSec !== null) {
        const rtlMs = (p.leadingEdgeTimeSec - p.emitTimeSec) * 1000;
        if (rtlMs >= 1.0 && rtlMs <= 125.0) {
          validRtlsMs.push(rtlMs);
        }
      }
    }

    if (validRtlsMs.length < 2) {
      return {
        success: false,
        medianRtlMs: null,
        detectedCount: validRtlsMs.length,
        totalPulses: pulses.length,
      };
    }

    const sorted = [...validRtlsMs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianRtlMs =
      sorted.length % 2 === 1
        ? sorted[mid]
        : 0.5 * (sorted[mid - 1] + sorted[mid]);

    return {
      success: true,
      medianRtlMs,
      detectedCount: validRtlsMs.length,
      totalPulses: pulses.length,
    };
  }
}
