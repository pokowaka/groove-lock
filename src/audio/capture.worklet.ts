import { LoopbackPingDetector } from '../dsp/loopback';
import { BassOnsetAnalyzer } from '../dsp/onset';
import type {
  InputChannelMode,
  MainToWorkletMessage,
  WorkletToMainMessage,
} from '../dsp/types';

// Minimal Web Audio Worklet global declarations for strict TypeScript
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;

declare const currentTime: number;
declare const sampleRate: number;

/** Frames per recorded `pcm` chunk (~85 ms at 48 kHz). */
const RECORD_CHUNK_FRAMES = 4096;

/**
 * Real-time Web Audio `AudioWorkletProcessor` running on the dedicated audio rendering thread.
 *
 * ### Responsibilities
 * 1. **Zero-Output Capture Sink:** Configured with `numberOfOutputs: 0` so dry instrument
 *    audio is analyzed in-place and never routed to browser speakers (eliminating software monitoring echo).
 * 2. **Pluck Onset & Pitch Detection:** Feeds every 128-sample block into `BassOnsetAnalyzer`
 *    and posts `pluck` events to the main thread as soon as post-attack YIN pitch settles.
 * 3. **Sample-Accurate Loopback Calibration:** When active, delegates incoming audio blocks
 *    to `LoopbackPingDetector` to measure hardware round-trip latency (RTL).
 * 4. **Throttled UI Telemetry (~30 fps):** Every 12 blocks (~32 ms at 48 kHz), posts a
 *    `meter` snapshot with IN 1 / IN 2 RMS levels and optional continuous tuner pitch.
 * 5. **Round Recording:** Between `start-record` and `stop-record`, streams the selected instrument
 *    channel (mono) to the main thread as `pcm` chunks timestamped on the `inputCtx` clock.
 */
class GrooveLockCaptureProcessor extends AudioWorkletProcessor {
  private readonly analyzer = new BassOnsetAnalyzer();
  private readonly loopback = new LoopbackPingDetector();
  private channelMode: InputChannelMode = 'auto';
  private meterBlockCounter = 0;
  private tunerBlockCounter = 0;

  private isRecording = false;
  private recordBuffer = new Float32Array(RECORD_CHUNK_FRAMES);
  private recordFill = 0;
  private recordChunkStartSec = 0;
  /** Slowly decaying per-channel energy used to pick the instrument channel in 'auto' mode. */
  private energyCh0 = 0;
  private energyCh1 = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<MainToWorkletMessage>) => {
      const msg = event.data;
      if (msg.type === 'config') {
        this.channelMode = msg.channelMode;
        this.analyzer.setConfig({
          channelMode: msg.channelMode,
          onsetThreshold: msg.onsetThreshold,
          instrumentRange: msg.instrumentRange,
        });
      } else if (msg.type === 'start-loopback') {
        this.loopback.start(msg.emitTimesSec);
      } else if (msg.type === 'stop-loopback') {
        this.loopback.stop();
      } else if (msg.type === 'start-record') {
        this.isRecording = true;
        this.recordFill = 0;
      } else if (msg.type === 'stop-record') {
        this.flushRecordChunk();
        this.isRecording = false;
        const outMsg: WorkletToMainMessage = { type: 'record-stopped' };
        this.port.postMessage(outMsg);
      }
    };
  }

  /** Appends one block of the selected instrument channel to the recording. */
  private recordBlock(ch0: Float32Array, ch1: Float32Array, rms0: number, rms1: number): void {
    this.energyCh0 = this.energyCh0 * 0.995 + rms0 * rms0;
    this.energyCh1 = this.energyCh1 * 0.995 + rms1 * rms1;
    if (this.recordFill === 0) {
      this.recordChunkStartSec = currentTime;
    }
    const mode = this.channelMode;
    const useCh1 = mode === '1' || (mode === 'auto' && this.energyCh1 > this.energyCh0);
    for (let i = 0; i < ch0.length; i++) {
      const sample = mode === 'sum' ? 0.5 * (ch0[i] + ch1[i]) : useCh1 ? ch1[i] : ch0[i];
      this.recordBuffer[this.recordFill++] = sample;
      if (this.recordFill === RECORD_CHUNK_FRAMES) {
        this.flushRecordChunk();
        this.recordChunkStartSec = currentTime + (i + 1) / sampleRate;
      }
    }
  }

  private flushRecordChunk(): void {
    if (this.recordFill === 0) {
      return;
    }
    const samples = this.recordBuffer.slice(0, this.recordFill);
    const outMsg: WorkletToMainMessage = {
      type: 'pcm',
      startTimeSec: this.recordChunkStartSec,
      sampleRate,
      samples,
    };
    this.port.postMessage(outMsg, [samples.buffer]);
    this.recordFill = 0;
  }

  /**
   * Invoked by the Web Audio rendering thread for every 128-sample render quantum (~2.67 ms at 48 kHz).
   */
  public override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const ch0 = input[0];
    const ch1 = input.length > 1 && input[1] ? input[1] : ch0;

    const analysis = this.analyzer.processBlock(
      ch0,
      ch1,
      currentTime,
      sampleRate,
      this.loopback.isActive(),
    );

    if (this.loopback.isActive()) {
      let activeSamples = ch0;
      if (this.channelMode === 'auto') {
        activeSamples = analysis.rmsCh0 >= analysis.rmsCh1 ? ch0 : ch1;
      } else if (this.channelMode === '1') {
        activeSamples = ch1;
      }
      const summary = this.loopback.processBlock(
        activeSamples,
        currentTime,
        sampleRate,
      );
      if (summary) {
        const outMsg: WorkletToMainMessage = {
          type: 'loopback-complete',
          summary,
        };
        this.port.postMessage(outMsg);
      }
    }

    if (this.isRecording) {
      this.recordBlock(ch0, ch1, analysis.rmsCh0, analysis.rmsCh1);
    }

    for (const pluck of analysis.completedPlucks) {
      const outMsg: WorkletToMainMessage = {
        type: 'pluck',
        event: pluck,
      };
      this.port.postMessage(outMsg);
    }

    this.meterBlockCounter++;
    this.tunerBlockCounter++;

    if (this.meterBlockCounter >= 12) {
      this.meterBlockCounter = 0;
      let livePitch = null;
      if (this.tunerBlockCounter >= 24) {
        this.tunerBlockCounter = 0;
        if (analysis.activeRms > this.analyzer.getOnsetThreshold() * 0.45) {
          livePitch = this.analyzer.detectCurrentPitch(sampleRate);
        }
      }

      const outMsg: WorkletToMainMessage = {
        type: 'meter',
        snapshot: {
          rmsCh0: analysis.rmsCh0,
          rmsCh1: analysis.rmsCh1,
          activeRms: analysis.activeRms,
          livePitch,
        },
      };
      this.port.postMessage(outMsg);
    }

    return true;
  }
}

registerProcessor('groove-lock-capture', GrooveLockCaptureProcessor);
