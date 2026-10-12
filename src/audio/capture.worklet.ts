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
 */
class GrooveLockCaptureProcessor extends AudioWorkletProcessor {
  private readonly analyzer = new BassOnsetAnalyzer();
  private readonly loopback = new LoopbackPingDetector();
  private channelMode: InputChannelMode = 'auto';
  private meterBlockCounter = 0;
  private tunerBlockCounter = 0;

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
      }
    };
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
