/**
 * Twelve-tone equal-temperament chromatic pitch class names.
 */
export type NoteClass =
  | 'C'
  | 'C#'
  | 'D'
  | 'D#'
  | 'E'
  | 'F'
  | 'F#'
  | 'G'
  | 'G#'
  | 'A'
  | 'A#'
  | 'B';

/**
 * Frequency search range preset used by the YIN pitch detector to avoid
 * sub-harmonic or high-overtone octave errors.
 * - `'bass'`: 30 Hz – 400 Hz (covers 5-string B0 = 30.87 Hz through high bass register)
 * - `'guitar'`: 75 Hz – 1100 Hz (covers drop-D/standard E2 = 82.4 Hz through high frets)
 * - `'full'`: 30 Hz – 1200 Hz
 */
export type InstrumentRange = 'bass' | 'guitar' | 'full';

/**
 * Hardware input channel selector for 2-channel USB audio interfaces (e.g. Focusrite Scarlett Solo).
 * - `'auto'`: Dynamically picks whichever channel (`ch0` or `ch1`) has higher RMS energy
 *   (handles both Scarlett Solo 4th Gen where Instrument is Input 1 and 3rd Gen where Instrument is Input 2).
 * - `'0'`: Forces Input 1 (`ch0`).
 * - `'1'`: Forces Input 2 (`ch1`).
 * - `'sum'`: Mono average `0.5 * (ch0 + ch1)`.
 */
export type InputChannelMode = 'auto' | '0' | '1' | 'sum';

/**
 * Minimum and maximum fundamental frequencies (in Hz) searched by YIN.
 */
export interface FrequencyBounds {
  readonly minFreqHz: number;
  readonly maxFreqHz: number;
}

/**
 * Result of a single YIN pitch estimation over an audio window.
 */
export interface PitchEstimate {
  /** Estimated fundamental frequency in Hz. */
  readonly freqHz: number;
  /** Chromatic pitch class (e.g. `'E'`, `'A#'`). */
  readonly noteClass: NoteClass;
  /** Scientific pitch octave number (e.g. `1` for open bass E1 = 41.2 Hz). */
  readonly octave: number;
  /** Combined note and octave string (e.g. `'E1'`, `'A2'`). */
  readonly fullName: string;
  /** Intonation deviation from equal-temperament center in cents (-50 to +50). */
  readonly cents: number;
  /** Periodicity confidence score in `[0, 1]` (`1 - yinAperiodicity`). */
  readonly confidence: number;
}

/**
 * Emitted by `BassOnsetAnalyzer` once a pluck onset has been detected and its
 * post-attack YIN pitch window has been evaluated.
 */
export interface DetectedPluckEvent {
  /** Sample-accurate onset timestamp in seconds (`AudioContext.currentTime` clock). */
  readonly rawOnsetTimeSec: number;
  /** Settled fundamental pitch estimate, or `null` for muted/percussive ghost notes. */
  readonly pitch: PitchEstimate | null;
  /** Peak 128-sample block RMS recorded at the initial attack transient. */
  readonly peakRms: number;
  /** Diagnostics: onset time on the `inputCtx` clock before conversion (set by `AudioEngine`). */
  readonly inputOnsetTimeSec?: number;
  /** Diagnostics: `outputCtx − inputCtx` clock offset used for the conversion. */
  readonly clockOffsetSec?: number;
}

/**
 * Periodic (~30 fps) level meter and live chromatic tuner snapshot sent from the
 * `AudioWorkletProcessor` to the main UI thread.
 */
export interface MeterSnapshot {
  /** Current RMS level of hardware Input 1 (`ch0`). */
  readonly rmsCh0: number;
  /** Current RMS level of hardware Input 2 (`ch1`). */
  readonly rmsCh1: number;
  /** Current RMS level of the selected instrument channel. */
  readonly activeRms: number;
  /** Highest absolute sample on either input since the previous snapshot (1.0 = digital full scale). */
  readonly peak: number;
  /** Optional continuous tuner pitch readout while a note is sustaining. */
  readonly livePitch: PitchEstimate | null;
}

/**
 * Per-ping measurement recorded during an automated hardware loopback latency test.
 */
export interface LoopbackPulseResult {
  /** Scheduled emission timestamp of the 1760 Hz sonar ping (in `inputCtx` seconds). */
  readonly emitTimeSec: number;
  /** First sample timestamp where the returning ping exceeded the noise-floor gate, or `null`. */
  readonly leadingEdgeTimeSec: number | null;
  /** Ambient peak amplitude measured in the `[-45ms, -2ms]` pre-ping window. */
  readonly baselinePeak: number;
  /** Maximum peak amplitude observed in the `[+1ms, +125ms]` return window. */
  readonly maxPeak: number;
}

/**
 * Aggregated result of a 6-pulse hardware loopback round-trip latency (RTL) test.
 */
export interface LoopbackSummary {
  /** `true` if at least 2 valid return pings were captured within `[1ms, 125ms]`. */
  readonly success: boolean;
  /** Median round-trip latency in milliseconds across all detected pings, or `null`. */
  readonly medianRtlMs: number | null;
  /** Number of pings successfully detected on the input channel. */
  readonly detectedCount: number;
  /** Total number of sonar pings emitted. */
  readonly totalPulses: number;
}

/**
 * Discriminated union of control messages sent from the Main UI Thread to the
 * `GrooveLockCaptureProcessor` `AudioWorklet`.
 */
export type MainToWorkletMessage =
  | {
      readonly type: 'config';
      readonly channelMode: InputChannelMode;
      readonly onsetThreshold: number;
      readonly instrumentRange: InstrumentRange;
    }
  | {
      readonly type: 'start-loopback';
      readonly emitTimesSec: readonly number[];
    }
  | {
      /** Start streaming the selected instrument channel as `pcm` chunks. */
      readonly type: 'start-record';
    }
  | {
      /** Flush the pending chunk, stop streaming, then reply with `record-stopped`. */
      readonly type: 'stop-record';
    }
  | {
      /** Start streaming both raw input channels as `diag-pcm` chunks (diagnostics). */
      readonly type: 'start-diag';
    }
  | {
      /** Flush, stop diagnostics streaming, then reply with `diag-stopped`. */
      readonly type: 'stop-diag';
    }
  | {
      readonly type: 'stop-loopback';
    };

/**
 * Discriminated union of telemetry/event messages sent from the
 * `GrooveLockCaptureProcessor` `AudioWorklet` to the Main UI Thread.
 */
export type WorkletToMainMessage =
  | {
      readonly type: 'pluck';
      readonly event: DetectedPluckEvent;
    }
  | {
      readonly type: 'meter';
      readonly snapshot: MeterSnapshot;
    }
  | {
      readonly type: 'loopback-complete';
      readonly summary: LoopbackSummary;
    }
  | {
      /** Raw mono instrument audio while recording. */
      readonly type: 'pcm';
      /** `inputCtx` time of the first sample. */
      readonly startTimeSec: number;
      readonly sampleRate: number;
      readonly samples: Float32Array;
    }
  | {
      /** Acknowledges `stop-record` after the final `pcm` chunk was posted. */
      readonly type: 'record-stopped';
    }
  | {
      /** Both raw input channels while a diagnostic recording runs. */
      readonly type: 'diag-pcm';
      /** `inputCtx` time of the first sample. */
      readonly startTimeSec: number;
      readonly sampleRate: number;
      readonly ch0: Float32Array;
      readonly ch1: Float32Array;
    }
  | {
      readonly type: 'diag-stopped';
    };
