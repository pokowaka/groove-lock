import { noteClassToBassFrequencyHz } from '../dsp/pitch-utils';
import type {
  DetectedPluckEvent,
  InputChannelMode,
  InstrumentRange,
  LoopbackSummary,
  MainToWorkletMessage,
  MeterSnapshot,
  WorkletToMainMessage,
} from '../dsp/types';
import {
  type BassGuideMode,
  type ClickPlacementMode,
  type GroovePatternId,
  isBassGuideActiveForBar,
  isStepAudible,
  type PatternStepDescriptor,
  type PocketFeelOffsetMs,
  resolvePatternBarSteps,
  type SoundEngineMode,
} from '../groove/patterns';
import {
  computeBarTarget,
  type DrillMode,
  type GapClickMode,
  isBarSilentInGapMode,
  type Subdivision,
  type TargetNoteEvent,
} from '../groove/timeline';
import { LOOPBACK_PING_SPACING_SEC } from '../dsp/loopback';
import captureWorkletUrl from './capture.worklet.ts?worker&url';
import { StudioDrumSynth } from './drum-synth';

/**
 * One sound the engine scheduled on the output, logged while recording so the backing track can
 * be re-rendered offline for playback. Times are on the `outputCtx` clock.
 */
export type ScheduledSound =
  | { readonly kind: 'click'; readonly timeSec: number; readonly variant: 'downbeat' | 'quarter' | 'subdivision' }
  | { readonly kind: 'kick' | 'snare' | 'hihat'; readonly timeSec: number; readonly level: number }
  | {
      readonly kind: 'bass';
      readonly timeSec: number;
      readonly freqHz: number;
      readonly gateSec: number;
      readonly level: number;
    }
  | { readonly kind: 'ping'; readonly timeSec: number };

/** Both raw input channels from a diagnostic recording. */
export interface DiagnosticPcmChunk {
  readonly inputTimeSec: number;
  readonly clockOffsetSec: number;
  readonly sampleRate: number;
  readonly ch0: Float32Array;
  readonly ch1: Float32Array;
}

/** Snapshot of both audio clocks for diagnostics. */
export interface ClockSnapshot {
  readonly perfNowMs: number;
  readonly outputTimeSec: number | null;
  readonly inputTimeSec: number | null;
  readonly outputLatencySec: number | null;
  readonly outputBaseLatencySec: number | null;
  readonly inputBaseLatencySec: number | null;
  readonly outputSampleRate: number | null;
  readonly inputSampleRate: number | null;
  readonly outputState: string | null;
  readonly inputState: string | null;
}

/** A chunk of recorded instrument audio. */
export interface RecordedPcmChunk {
  /** `inputCtx` time of the first sample. */
  readonly inputTimeSec: number;
  /** `outputCtx.currentTime − inputCtx.currentTime` measured when the chunk arrived. */
  readonly clockOffsetSec: number;
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

/**
 * Extended `AudioContext` interface including Chromium's `setSinkId()` output routing API.
 */
export interface SinkableAudioContext extends AudioContext {
  setSinkId?: (sinkId: string | { type: 'none' }) => Promise<void>;
}

/**
 * Enumerated hardware audio input and output device lists along with auto-resolved device IDs.
 */
export interface AudioDeviceLists {
  readonly inputs: readonly MediaDeviceInfo[];
  readonly outputs: readonly MediaDeviceInfo[];
  readonly resolvedInputId: string;
  readonly resolvedOutputId: string;
}

/**
 * Event callbacks invoked by `AudioEngine` on the main UI thread.
 */
export interface AudioEngineCallbacks {
  /** Called at ~30 fps with live IN 1 / IN 2 RMS meters and optional tuner pitch. */
  readonly onMeter: (snapshot: MeterSnapshot) => void;
  /** Called whenever a plucked note has been detected and pitch-analyzed, with its timestamp translated to `outputCtx` time. */
  readonly onPluck: (event: DetectedPluckEvent) => void;
  /** Called whenever the lookahead metronome schedules an active `TargetNoteEvent`. */
  readonly onTargetScheduled: (event: TargetNoteEvent) => void;
  /** Called on exact quarter-note boundaries to illuminate the 4-beat visual rack lamps. */
  readonly onBeatLamp: (
    beatInBar: number,
    barNumber: number,
    isSilentGapBar: boolean,
  ) => void;
  /** Called on every pattern step boundary to animate the Bar Pattern Step Indicator and active note display. */
  readonly onStepLamp?: (
    step: PatternStepDescriptor,
    target: TargetNoteEvent,
  ) => void;
  /** Called when an automated 6-ping hardware loopback calibration completes. */
  readonly onLoopbackComplete: (summary: LoopbackSummary) => void;
  /**
   * Called (ahead of time, at schedule time) whenever a count-in bar or a graded bar is scheduled,
   * so real-time views can position a playhead against `getAudioClockSec()`.
   */
  readonly onBarScheduled?: (info: BarScheduleInfo) => void;
  /** Called on each audible count-in beat (`0..3`), roughly when it is heard. */
  readonly onCountInBeat?: (beatInBar: number) => void;
  /** Called after the final graded bar of a round, its landing hit and a short grace period. */
  readonly onRoundComplete?: () => void;
  /** Called with each recorded instrument chunk between `startRecording()` and `stopRecording()`. */
  readonly onPcmChunk?: (chunk: RecordedPcmChunk) => void;
  /** Diagnostics: called with both raw input channels while a diagnostic recording runs. */
  readonly onDiagnosticChunk?: (chunk: DiagnosticPcmChunk) => void;
  /** Diagnostics: called for every sound scheduled on the output (incl. loopback pings). */
  readonly onSoundScheduled?: (sound: ScheduledSound) => void;
}

/**
 * Timing and content of one scheduled bar, expressed on the `outputCtx` clock.
 */
export interface BarScheduleInfo {
  /** `'count-in'` bars are never graded; `'play'` bars carry target steps. */
  readonly kind: 'count-in' | 'play';
  /** Zero-based graded bar number (`-1` for the count-in). */
  readonly barNumber: number;
  /** Bar start in `outputCtx.currentTime` seconds. */
  readonly startTimeSec: number;
  /** Bar duration in seconds at the tempo it was scheduled with. */
  readonly durationSec: number;
  /** Steps of the bar (empty for count-in bars). */
  readonly steps: readonly PatternStepDescriptor[];
  /** `true` if the Gap Click trainer mutes this bar. */
  readonly isSilentGapBar: boolean;
  /** `true` if the reference bass plays this bar. */
  readonly isGuideBar: boolean;
  /** Target pitch class for this bar. */
  readonly expectedNote: TargetNoteEvent['expectedNote'];
}

/**
 * Manages the dual-`AudioContext` hardware architecture, Web Audio lookahead metronome
 * & synthesized drum/bass scheduler, and sample-accurate loopback calibration.
 */
export class AudioEngine {
  private outputCtx: SinkableAudioContext | null = null;
  private inputCtx: SinkableAudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletModuleLoaded = false;

  private readonly drumSynth = new StudioDrumSynth();

  private isRunning = false;
  private schedulerTimerId: number | null = null;
  private currentStepInBar = 0;
  private currentBarNumber = 0;
  private nextNoteTimeSec = 0;
  private hasStartedFirstStep = false;

  private bpm = 90;
  private subdivision: Subdivision = 1;
  private groovePattern: GroovePatternId = 'uniform';
  private soundMode: SoundEngineMode = 'click';
  private bassGuideMode: BassGuideMode = 'off';
  private clickPlacement: ClickPlacementMode = 'all';
  private pocketCenterMs: PocketFeelOffsetMs = 0;
  private gapBars: GapClickMode = 0;
  private drillMode: DrillMode = 'free';
  private activeBarTargetNote: TargetNoteEvent['expectedNote'] = 'ANY';

  /** Count-in bars played before bar 0 of each start (`0` disables). */
  private countInBars = 1;
  /** Graded bars per round; `0` runs continuously. */
  private roundBars = 0;
  private countInBeatsRemaining = 0;
  private roundFinishTimerId: number | null = null;

  /** Scheduled sounds since `beginSoundLog()`, or `null` when not logging. */
  private soundLog: ScheduledSound[] | null = null;
  private recordStopResolvers: (() => void)[] = [];
  private diagStopResolvers: (() => void)[] = [];
  private inputClockDeviceLabel: string | null = null;
  /** Output-input clock offset over time, for drift monitoring (first sample kept as reference). */
  private clockOffsetSamples: { atMs: number; offsetMs: number }[] = [];

  private channelMode: InputChannelMode = 'auto';
  private onsetThreshold = 0.035;
  private instrumentRange: InstrumentRange = 'bass';

  private readonly callbacks: AudioEngineCallbacks;

  constructor(callbacks: AudioEngineCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Returns the active hardware sample rate in Hz (e.g. `48000`), or `null` before initialization.
   */
  public getOutputSampleRate(): number | null {
    return this.inputCtx
      ? this.inputCtx.sampleRate
      : this.outputCtx
        ? this.outputCtx.sampleRate
        : null;
  }

  /** The output context (click track, drums, playback), or `null` before first use. */
  public getOutputContext(): AudioContext | null {
    return this.outputCtx;
  }

  /**
   * Returns `true` if the USB audio input stream and capture worklet are actively connected.
   */
  public isInputConnected(): boolean {
    return this.inputCtx !== null && this.workletNode !== null;
  }

  /**
   * Returns `true` if the lookahead metronome scheduler is currently running.
   */
  public isMetronomeRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Returns the current zero-based bar number since transport start.
   */
  public getCurrentBarNumber(): number {
    return this.currentBarNumber;
  }

  /**
   * Returns the effective subdivision density for the currently selected groove pattern.
   */
  public getEffectiveSubdivision(): Subdivision {
    const steps = resolvePatternBarSteps(this.groovePattern, this.subdivision);
    return steps[0]?.subdivision ?? this.subdivision;
  }

  /**
   * Returns the `outputCtx` time of the audio currently reaching the speakers (current time minus
   * reported output latency), or `null` before the output context exists. Use it to draw
   * playheads that line up with what the player hears.
   */
  public getAudioClockSec(): number | null {
    if (!this.outputCtx) {
      return null;
    }
    const latencySec =
      this.outputCtx.outputLatency || this.outputCtx.baseLatency || 0;
    return this.outputCtx.currentTime - latencySec;
  }

  /**
   * Updates metronome tempo, subdivision grid, groove pattern, sound engine, reference bass guide,
   * click placement, pocket feel center, gap-click mode, note exercise mode, count-in or round length.
   * Count-in and round length take effect on the next `startMetronome()`.
   */
  public setTransportConfig(config: {
    bpm?: number;
    subdivision?: Subdivision;
    groovePattern?: GroovePatternId;
    soundMode?: SoundEngineMode;
    bassGuideMode?: BassGuideMode;
    clickPlacement?: ClickPlacementMode;
    pocketCenterMs?: PocketFeelOffsetMs;
    gapBars?: GapClickMode;
    drillMode?: DrillMode;
    countInBars?: number;
    roundBars?: number;
  }): void {
    if (config.countInBars !== undefined) {
      this.countInBars = Math.max(0, Math.floor(config.countInBars));
    }
    if (config.roundBars !== undefined) {
      this.roundBars = Math.max(0, Math.floor(config.roundBars));
    }
    if (config.bpm !== undefined) {
      this.bpm = config.bpm;
    }
    if (config.subdivision !== undefined) {
      this.subdivision = config.subdivision;
    }
    if (config.groovePattern !== undefined) {
      this.groovePattern = config.groovePattern;
      this.currentStepInBar = 0;
    }
    if (config.soundMode !== undefined) {
      this.soundMode = config.soundMode;
    }
    if (config.bassGuideMode !== undefined) {
      this.bassGuideMode = config.bassGuideMode;
    }
    if (config.clickPlacement !== undefined) {
      this.clickPlacement = config.clickPlacement;
    }
    if (config.pocketCenterMs !== undefined) {
      this.pocketCenterMs = config.pocketCenterMs;
    }
    if (config.gapBars !== undefined) {
      this.gapBars = config.gapBars;
    }
    if (config.drillMode !== undefined) {
      this.drillMode = config.drillMode;
      this.activeBarTargetNote = computeBarTarget(
        this.drillMode,
        this.currentBarNumber,
      ).targetNote;
    }
  }

  /**
   * Updates DSP parameters and forwards them to the `AudioWorkletProcessor`.
   */
  public setDspConfig(config: {
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
    this.postWorkletConfig();
  }

  private postWorkletConfig(): void {
    if (!this.workletNode) {
      return;
    }
    const msg: MainToWorkletMessage = {
      type: 'config',
      channelMode: this.channelMode,
      onsetThreshold: this.onsetThreshold,
      instrumentRange: this.instrumentRange,
    };
    this.workletNode.port.postMessage(msg);
  }

  /**
   * Queries `navigator.mediaDevices.enumerateDevices()` and auto-selects Focusrite/Scarlett
   * hardware when no explicit device ID has been saved yet.
   */
  public async enumerateAndResolveDevices(
    preferredInputId: string,
    preferredOutputId: string,
  ): Promise<AudioDeviceLists> {
    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.enumerateDevices
    ) {
      return {
        inputs: [],
        outputs: [],
        resolvedInputId: '',
        resolvedOutputId: '',
      };
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const outputs = devices.filter((d) => d.kind === 'audiooutput');

    let resolvedInputId = preferredInputId;
    if (
      resolvedInputId &&
      !inputs.some((d) => d.deviceId === resolvedInputId)
    ) {
      resolvedInputId = '';
    }
    if (!resolvedInputId) {
      const scarlettIn = inputs.find((d) =>
        /scarlett|focusrite/i.test(d.label),
      );
      resolvedInputId = scarlettIn
        ? scarlettIn.deviceId
        : inputs[0]?.deviceId ?? '';
    }

    let resolvedOutputId = preferredOutputId;
    if (
      resolvedOutputId &&
      !outputs.some((d) => d.deviceId === resolvedOutputId)
    ) {
      resolvedOutputId = '';
    }
    if (!resolvedOutputId) {
      const scarlettOut = outputs.find((d) =>
        /scarlett|focusrite/i.test(d.label),
      );
      if (scarlettOut) {
        resolvedOutputId = scarlettOut.deviceId;
      }
    }

    return {
      inputs,
      outputs,
      resolvedInputId,
      resolvedOutputId,
    };
  }

  /**
   * Routes `outputCtx` (click track & calibration pings) to the specified output `sinkDeviceId`
   * via `AudioContext.setSinkId()`. Optionally plays a short confirmation tick.
   */
  public async applyOutputDevice(
    sinkDeviceId: string,
    playConfirmationTick: boolean,
  ): Promise<'direct' | 'default' | 'unsupported' | 'error'> {
    if (!this.outputCtx) {
      this.outputCtx = new AudioContext({
        latencyHint: 'interactive',
      }) as SinkableAudioContext;
    }

    let status: 'direct' | 'default' | 'unsupported' | 'error' = 'default';
    if (typeof this.outputCtx.setSinkId === 'function') {
      try {
        await this.outputCtx.setSinkId(sinkDeviceId || '');
        if (this.outputCtx.state === 'suspended') {
          await this.outputCtx.resume();
        }
        status = sinkDeviceId ? 'direct' : 'default';
      } catch {
        status = 'error';
      }
    } else {
      status = 'unsupported';
    }

    if (playConfirmationTick && this.outputCtx) {
      if (this.outputCtx.state === 'suspended') {
        await this.outputCtx.resume();
      }
      const t = this.outputCtx.currentTime + 0.02;
      this.drumSynth.scheduleClick(this.outputCtx, t, 'downbeat');
    }

    return status;
  }

  /**
   * Opens the requested USB audio input with raw studio constraints (`echoCancellation: false`,
   * `noiseSuppression: false`, `autoGainControl: false`, `channelCount: 2`) and attaches it
   * to the zero-output `GrooveLockCaptureProcessor` worklet on `inputCtx`.
   */
  public async connectInput(
    requestedDeviceId: string,
    preferredOutputId: string,
  ): Promise<AudioDeviceLists> {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
    }

    const constraints: MediaTrackConstraints = {
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: false },
      channelCount: { ideal: 2 },
    };

    if (requestedDeviceId) {
      constraints.deviceId = { exact: requestedDeviceId };
    }

    let stream = await navigator.mediaDevices.getUserMedia({
      audio: constraints,
      video: false,
    });

    if (!this.outputCtx) {
      this.outputCtx = new AudioContext({
        latencyHint: 'interactive',
      }) as SinkableAudioContext;
    }
    if (this.outputCtx.state === 'suspended') {
      await this.outputCtx.resume();
    }

    if (!this.inputCtx) {
      this.inputCtx = new AudioContext({
        latencyHint: 'interactive',
      }) as SinkableAudioContext;
      if (typeof this.inputCtx.setSinkId === 'function') {
        try {
          await this.inputCtx.setSinkId({ type: 'none' });
        } catch {
          // Ignore if { type: 'none' } sink is unsupported
        }
      }
    }
    if (this.inputCtx.state === 'suspended') {
      await this.inputCtx.resume();
    }

    const deviceLists = await this.enumerateAndResolveDevices(
      requestedDeviceId,
      preferredOutputId,
    );

    const activeTrack = stream.getAudioTracks()[0];
    const openedDeviceId = activeTrack?.getSettings?.().deviceId ?? '';
    if (
      !requestedDeviceId &&
      deviceLists.resolvedInputId &&
      openedDeviceId &&
      openedDeviceId !== deviceLists.resolvedInputId
    ) {
      stream.getTracks().forEach((t) => t.stop());
      constraints.deviceId = { exact: deviceLists.resolvedInputId };
      stream = await navigator.mediaDevices.getUserMedia({
        audio: constraints,
        video: false,
      });
    }

    this.mediaStream = stream;
    await this.lockInputClockToDevice(stream, deviceLists.outputs);

    if (this.sourceNode) {
      this.sourceNode.disconnect();
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
    }

    this.sourceNode = this.inputCtx.createMediaStreamSource(stream);

    if (!this.workletModuleLoaded) {
      await this.inputCtx.audioWorklet.addModule(captureWorkletUrl);
      this.workletModuleLoaded = true;
    }

    this.workletNode = new AudioWorkletNode(
      this.inputCtx,
      'groove-lock-capture',
      {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      },
    );

    this.workletNode.port.onmessage = (
      event: MessageEvent<WorkletToMainMessage>,
    ) => {
      this.handleWorkletMessage(event.data);
    };

    this.postWorkletConfig();
    this.sourceNode.connect(this.workletNode);

    return deviceLists;
  }

  /**
   * Runs `inputCtx` on the audio interface's own clock by giving it the interface's (silent)
   * output as its sink. With a `'none'` sink the input context runs on a separate clock that drifts
   * against the interface (measured ~77 ppm on a Scarlett Solo); the browser then buffers the
   * difference and the input delay creeps up during a session. The capture worklet has no outputs,
   * so nothing is ever played on this sink. Falls back to `'none'` when no matching output exists.
   */
  private async lockInputClockToDevice(
    stream: MediaStream,
    outputs: readonly MediaDeviceInfo[],
  ): Promise<void> {
    this.inputClockDeviceLabel = null;
    const ctx = this.inputCtx;
    if (!ctx || typeof ctx.setSinkId !== 'function') {
      return;
    }
    const groupId = stream.getAudioTracks()[0]?.getSettings?.().groupId ?? '';
    const sameDevice = groupId ? outputs.find((d) => d.groupId === groupId && d.deviceId) : undefined;
    try {
      if (sameDevice) {
        await ctx.setSinkId(sameDevice.deviceId);
        this.inputClockDeviceLabel = sameDevice.label || 'audio interface';
      } else {
        await ctx.setSinkId({ type: 'none' });
      }
    } catch {
      try {
        await ctx.setSinkId({ type: 'none' });
      } catch {
        // Keep whatever sink the context has.
      }
    }
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.clockOffsetSamples = [];
  }

  /** Restarts drift measurement (call after calibrating latency). */
  public resetDriftBaseline(): void {
    this.clockOffsetSamples = [];
  }

  /** Label of the device whose clock drives the input context, or `null` if it runs on its own. */
  public getInputClockDeviceLabel(): string | null {
    return this.inputClockDeviceLabel;
  }

  /**
   * How much the output-input clock offset has moved since the input was connected (ms, median of
   * the latest 10 s vs. the first 10 s). Growth means input samples are piling up in the browser's
   * buffer, i.e. the input delay has increased by about that much since calibration.
   */
  public getInputDriftMs(): number | null {
    const samples = this.clockOffsetSamples;
    if (samples.length < 20) return null;
    const t0 = samples[0].atMs;
    const tEnd = samples[samples.length - 1].atMs;
    const med = (xs: number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const first = med(samples.filter((x) => x.atMs - t0 <= 10000).map((x) => x.offsetMs));
    const last = med(samples.filter((x) => tEnd - x.atMs <= 10000).map((x) => x.offsetMs));
    return last - first;
  }

  private recordClockOffset(): void {
    if (!this.outputCtx || !this.inputCtx) return;
    const atMs = performance.now();
    const lastSample = this.clockOffsetSamples[this.clockOffsetSamples.length - 1];
    if (lastSample && atMs - lastSample.atMs < 250) return;
    this.clockOffsetSamples.push({
      atMs,
      offsetMs: (this.outputCtx.currentTime - this.inputCtx.currentTime) * 1000,
    });
    if (this.clockOffsetSamples.length > 20000) {
      this.clockOffsetSamples.splice(1, 1);
    }
  }

  private handleWorkletMessage(msg: WorkletToMainMessage): void {
    if (msg.type === 'meter') {
      this.recordClockOffset();
      this.callbacks.onMeter(msg.snapshot);
    } else if (msg.type === 'pluck') {
      if (!this.outputCtx || !this.inputCtx) {
        return;
      }
      const clockOffsetSec =
        this.outputCtx.currentTime - this.inputCtx.currentTime;
      this.callbacks.onPluck({
        ...msg.event,
        rawOnsetTimeSec: msg.event.rawOnsetTimeSec + clockOffsetSec,
        inputOnsetTimeSec: msg.event.rawOnsetTimeSec,
        clockOffsetSec,
      });
    } else if (msg.type === 'loopback-complete') {
      this.callbacks.onLoopbackComplete(msg.summary);
    } else if (msg.type === 'pcm') {
      if (!this.outputCtx || !this.inputCtx) {
        return;
      }
      this.callbacks.onPcmChunk?.({
        inputTimeSec: msg.startTimeSec,
        clockOffsetSec: this.outputCtx.currentTime - this.inputCtx.currentTime,
        sampleRate: msg.sampleRate,
        samples: msg.samples,
      });
    } else if (msg.type === 'diag-pcm') {
      if (!this.outputCtx || !this.inputCtx) {
        return;
      }
      this.callbacks.onDiagnosticChunk?.({
        inputTimeSec: msg.startTimeSec,
        clockOffsetSec: this.outputCtx.currentTime - this.inputCtx.currentTime,
        sampleRate: msg.sampleRate,
        ch0: msg.ch0,
        ch1: msg.ch1,
      });
    } else if (msg.type === 'diag-stopped') {
      const resolvers = this.diagStopResolvers;
      this.diagStopResolvers = [];
      resolvers.forEach((resolve) => resolve());
    } else if (msg.type === 'record-stopped') {
      const resolvers = this.recordStopResolvers;
      this.recordStopResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  /**
   * Starts the Web Audio lookahead metronome scheduler (`25 ms` timer interval, `100 ms` lookahead).
   * Lazily initializes `outputCtx` if the user has not yet connected an audio input interface.
   */
  public startMetronome(): void {
    if (this.isRunning) {
      return;
    }
    if (!this.outputCtx) {
      this.outputCtx = new AudioContext({
        latencyHint: 'interactive',
      }) as SinkableAudioContext;
    }
    if (this.outputCtx.state === 'suspended') {
      void this.outputCtx.resume();
    }

    this.isRunning = true;
    this.currentStepInBar = 0;
    this.currentBarNumber = 0;
    this.hasStartedFirstStep = false;
    this.nextNoteTimeSec = this.outputCtx.currentTime + 0.06;
    this.activeBarTargetNote = computeBarTarget(this.drillMode, 0).targetNote;
    this.countInBeatsRemaining = this.countInBars * 4;

    this.schedulerTimerId = window.setInterval(() => {
      this.runMetronomeScheduler();
    }, 25);
  }

  /**
   * Stops the lookahead metronome scheduler (and cancels a pending round completion).
   */
  public stopMetronome(): void {
    this.isRunning = false;
    if (this.schedulerTimerId !== null) {
      window.clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
    if (this.roundFinishTimerId !== null) {
      window.clearTimeout(this.roundFinishTimerId);
      this.roundFinishTimerId = null;
    }
  }

  /**
   * Starts streaming the instrument channel via `onPcmChunk`.
   *
   * @return `false` if no input is connected (nothing will be recorded).
   */
  public startRecording(): boolean {
    if (!this.workletNode) {
      return false;
    }
    const msg: MainToWorkletMessage = { type: 'start-record' };
    this.workletNode.port.postMessage(msg);
    return true;
  }

  /**
   * Stops streaming; resolves once the final chunk has been delivered (or after a 500 ms timeout).
   */
  public stopRecording(): Promise<void> {
    if (!this.workletNode) {
      return Promise.resolve();
    }
    const done = new Promise<void>((resolve) => {
      this.recordStopResolvers.push(resolve);
      window.setTimeout(resolve, 500);
    });
    const msg: MainToWorkletMessage = { type: 'stop-record' };
    this.workletNode.port.postMessage(msg);
    return done;
  }

  /** Diagnostics: starts streaming both raw input channels via `onDiagnosticChunk`. */
  public startDiagnosticRecording(): boolean {
    if (!this.workletNode) {
      return false;
    }
    const msg: MainToWorkletMessage = { type: 'start-diag' };
    this.workletNode.port.postMessage(msg);
    return true;
  }

  /** Diagnostics: stops streaming; resolves after the final chunk (or a 500 ms timeout). */
  public stopDiagnosticRecording(): Promise<void> {
    if (!this.workletNode) {
      return Promise.resolve();
    }
    const done = new Promise<void>((resolve) => {
      this.diagStopResolvers.push(resolve);
      window.setTimeout(resolve, 500);
    });
    const msg: MainToWorkletMessage = { type: 'stop-diag' };
    this.workletNode.port.postMessage(msg);
    return done;
  }

  /** Diagnostics: both audio clocks, latencies and states right now. */
  public getClockSnapshot(): ClockSnapshot {
    const out = this.outputCtx;
    const inp = this.inputCtx;
    return {
      perfNowMs: performance.now(),
      outputTimeSec: out?.currentTime ?? null,
      inputTimeSec: inp?.currentTime ?? null,
      outputLatencySec: out?.outputLatency ?? null,
      outputBaseLatencySec: out?.baseLatency ?? null,
      inputBaseLatencySec: inp?.baseLatency ?? null,
      outputSampleRate: out?.sampleRate ?? null,
      inputSampleRate: inp?.sampleRate ?? null,
      outputState: out?.state ?? null,
      inputState: inp?.state ?? null,
    };
  }

  /** Diagnostics: settings and label of the open input track. */
  public getInputTrackInfo(): { label: string; settings: MediaTrackSettings } | null {
    const track = this.mediaStream?.getAudioTracks()[0];
    return track ? { label: track.label, settings: track.getSettings() } : null;
  }

  /** Starts logging every sound the scheduler plays (count-in, groove, landing, reference bass). */
  public beginSoundLog(): void {
    this.soundLog = [];
  }

  /** Returns the sounds logged since `beginSoundLog()` and stops logging. */
  public takeSoundLog(): ScheduledSound[] {
    const log = this.soundLog ?? [];
    this.soundLog = null;
    return log;
  }

  private playClick(timeSec: number, variant: 'downbeat' | 'quarter' | 'subdivision'): void {
    if (!this.outputCtx) return;
    this.drumSynth.scheduleClick(this.outputCtx, timeSec, variant);
    this.soundLog?.push({ kind: 'click', timeSec, variant });
    this.callbacks.onSoundScheduled?.({ kind: 'click', timeSec, variant });
  }

  private playDrum(kind: 'kick' | 'snare' | 'hihat', timeSec: number, level: number): void {
    if (!this.outputCtx) return;
    if (kind === 'kick') this.drumSynth.scheduleKick(this.outputCtx, timeSec, level);
    else if (kind === 'snare') this.drumSynth.scheduleSnare(this.outputCtx, timeSec, level);
    else this.drumSynth.scheduleHiHat(this.outputCtx, timeSec, level);
    this.soundLog?.push({ kind, timeSec, level });
    this.callbacks.onSoundScheduled?.({ kind, timeSec, level });
  }

  private runMetronomeScheduler(): void {
    if (!this.outputCtx || !this.isRunning || this.schedulerTimerId === null) {
      return;
    }
    const scheduleAheadSec = 0.1;

    while (
      this.nextNoteTimeSec <
      this.outputCtx.currentTime + scheduleAheadSec
    ) {
      if (this.countInBeatsRemaining > 0) {
        this.scheduleCountInBeat();
        continue;
      }

      const barSteps = resolvePatternBarSteps(
        this.groovePattern,
        this.subdivision,
      );
      if (this.currentStepInBar >= barSteps.length) {
        this.currentStepInBar = 0;
      }

      if (this.currentStepInBar === 0 && this.hasStartedFirstStep) {
        if (this.roundBars > 0 && this.currentBarNumber + 1 >= this.roundBars) {
          this.finishRound(this.nextNoteTimeSec);
          return;
        }
        this.currentBarNumber++;
        this.activeBarTargetNote = computeBarTarget(
          this.drillMode,
          this.currentBarNumber,
        ).targetNote;
      }
      this.hasStartedFirstStep = true;

      const step = barSteps[this.currentStepInBar];
      const isSilentGapBar = isBarSilentInGapMode(
        this.currentBarNumber,
        this.gapBars,
      );
      const guideBassPlayingThisBar = isBassGuideActiveForBar(
        this.currentBarNumber,
        this.bassGuideMode,
      );
      const secondsPerBeat = 60.0 / this.bpm;

      if (this.currentStepInBar === 0) {
        const barBeats = barSteps.reduce((acc, s) => acc + s.durationBeats, 0);
        this.callbacks.onBarScheduled?.({
          kind: 'play',
          barNumber: this.currentBarNumber,
          startTimeSec: this.nextNoteTimeSec,
          durationSec: barBeats * secondsPerBeat,
          steps: barSteps,
          isSilentGapBar,
          isGuideBar: guideBassPlayingThisBar,
          expectedNote: this.activeBarTargetNote,
        });
      }

      const targetEvent: TargetNoteEvent = {
        id: `${this.currentBarNumber}:${step.beatInBar}:${step.subIndex}`,
        timeSec: this.nextNoteTimeSec,
        barNumber: this.currentBarNumber,
        beatInBar: step.beatInBar,
        subIndex: step.subIndex,
        beatLabel: step.beatLabel,
        expectedNote: this.activeBarTargetNote,
        isSilentGapBar,
      };

      this.scheduleStepAudioAndLamps(
        step,
        targetEvent,
        guideBassPlayingThisBar,
      );

      if (step.isTargetActive) {
        this.callbacks.onTargetScheduled(targetEvent);
      }

      this.nextNoteTimeSec += secondsPerBeat * step.durationBeats;
      this.currentStepInBar = (this.currentStepInBar + 1) % barSteps.length;
    }
  }

  /**
   * Schedules one quarter-note count-in click. Count-in clicks are always audible (independent of
   * click placement and gap mode) and never produce target events.
   */
  private scheduleCountInBeat(): void {
    if (!this.outputCtx) {
      return;
    }
    const totalBeats = this.countInBars * 4;
    const beatIndex = totalBeats - this.countInBeatsRemaining;
    const beatInBar = beatIndex % 4;
    const secondsPerBeat = 60.0 / this.bpm;
    const timeSec = this.nextNoteTimeSec;

    if (beatInBar === 0) {
      this.callbacks.onBarScheduled?.({
        kind: 'count-in',
        barNumber: -1,
        startTimeSec: timeSec,
        durationSec: 4 * secondsPerBeat,
        steps: [],
        isSilentGapBar: false,
        isGuideBar: false,
        expectedNote: this.activeBarTargetNote,
      });
    }

    this.playClick(timeSec, beatInBar === 0 ? 'downbeat' : 'quarter');
    this.runAtAudioTime(timeSec, () => {
      this.callbacks.onCountInBeat?.(beatInBar);
    });

    this.nextNoteTimeSec += secondsPerBeat;
    this.countInBeatsRemaining--;
  }

  /**
   * Ends a round: schedules a landing hit on the downbeat after the last graded bar, stops
   * scheduling, and reports completion after a grace period so late final notes still grade.
   * `isRunning` stays `true` until completion so plucks keep being evaluated.
   */
  private finishRound(landingTimeSec: number): void {
    if (!this.outputCtx) {
      return;
    }
    if (this.schedulerTimerId !== null) {
      window.clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }

    if (this.soundMode === 'drums') {
      this.playDrum('kick', landingTimeSec, 0.62);
      this.playDrum('hihat', landingTimeSec, 0.2);
    } else {
      this.playClick(landingTimeSec, 'downbeat');
    }

    const graceSec = Math.max(0.3, 0.5 * (60.0 / this.bpm));
    const delayMs = Math.max(
      0,
      (landingTimeSec + graceSec - this.outputCtx.currentTime) * 1000,
    );
    this.roundFinishTimerId = window.setTimeout(() => {
      this.roundFinishTimerId = null;
      this.isRunning = false;
      this.callbacks.onRoundComplete?.();
    }, delayMs);
  }

  private runAtAudioTime(timeSec: number, fn: () => void): void {
    if (!this.outputCtx) {
      return;
    }
    const delayMs = Math.max(0, (timeSec - this.outputCtx.currentTime) * 1000);
    window.setTimeout(() => {
      if (this.isRunning) {
        fn();
      }
    }, delayMs);
  }

  private scheduleClickOrDrumForStep(
    step: PatternStepDescriptor,
    timeSec: number,
    isSilentGapBar: boolean,
  ): void {
    if (!this.outputCtx) {
      return;
    }
    const audible = isStepAudible(
      step,
      this.clickPlacement,
      isSilentGapBar,
    );
    if (!audible) {
      return;
    }

    if (this.soundMode === 'drums') {
      if (step.subIndex === 0) {
        if (step.beatInBar === 0 || step.beatInBar === 2) {
          this.playDrum('kick', timeSec, 0.58);
          this.playDrum('hihat', timeSec, 0.14);
        } else {
          this.playDrum('snare', timeSec, 0.42);
          this.playDrum('hihat', timeSec, 0.16);
        }
      } else {
        this.playDrum('hihat', timeSec, 0.12);
      }
    } else {
      if (step.subIndex === 0 && step.beatInBar === 0) {
        this.playClick(timeSec, 'downbeat');
      } else if (step.subIndex === 0) {
        this.playClick(timeSec, 'quarter');
      } else {
        this.playClick(timeSec, 'subdivision');
      }
    }
  }

  private scheduleStepAudioAndLamps(
    step: PatternStepDescriptor,
    target: TargetNoteEvent,
    playGuideBass: boolean,
  ): void {
    if (!this.outputCtx) {
      return;
    }

    this.scheduleClickOrDrumForStep(
      step,
      target.timeSec,
      target.isSilentGapBar,
    );

    if (playGuideBass && step.isTargetActive && !target.isSilentGapBar) {
      const secondsPerBeat = 60.0 / this.bpm;
      const bassTimeSec = target.timeSec + this.pocketCenterMs / 1000;
      const freqHz = noteClassToBassFrequencyHz(
        target.expectedNote,
        this.instrumentRange,
        step.octaveShift,
      );
      const gateSec = step.gateBeats * secondsPerBeat;
      this.drumSynth.scheduleBassNote(this.outputCtx, bassTimeSec, freqHz, gateSec, 0.38);
      this.soundLog?.push({ kind: 'bass', timeSec: bassTimeSec, freqHz, gateSec, level: 0.38 });
      this.callbacks.onSoundScheduled?.({ kind: 'bass', timeSec: bassTimeSec, freqHz, gateSec, level: 0.38 });
    }

    const delayMs = Math.max(
      0,
      (target.timeSec - this.outputCtx.currentTime) * 1000,
    );
    window.setTimeout(() => {
      if (!this.isRunning) {
        return;
      }
      if (step.subIndex === 0) {
        this.callbacks.onBeatLamp(
          target.beatInBar,
          target.barNumber,
          target.isSilentGapBar,
        );
      }
      this.callbacks.onStepLamp?.(step, target);
    }, delayMs);
  }

  /**
   * Emits 6 short 1760 Hz sonar pings on `outputCtx` (spaced 600 ms apart) and instructs
   * the `AudioWorkletProcessor` on `inputCtx` to measure the exact sample arrival time.
   */
  public startLoopbackPingTest(): void {
    if (!this.outputCtx || !this.inputCtx || !this.workletNode) {
      return;
    }
    if (this.isRunning) {
      this.stopMetronome();
    }

    const nowOut = this.outputCtx.currentTime;
    const clockOffsetToInput =
      this.inputCtx.currentTime - this.outputCtx.currentTime;
    const numPulses = 6;
    const spacingSec = LOOPBACK_PING_SPACING_SEC;
    const inputEmitTimesSec: number[] = [];

    for (let i = 0; i < numPulses; i++) {
      const outEmitTime = nowOut + 0.35 + i * spacingSec;
      inputEmitTimesSec.push(outEmitTime + clockOffsetToInput);
      this.callbacks.onSoundScheduled?.({ kind: 'ping', timeSec: outEmitTime });

      const osc = this.outputCtx.createOscillator();
      const gain = this.outputCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1760, outEmitTime);
      gain.gain.setValueAtTime(0.65, outEmitTime);
      gain.gain.exponentialRampToValueAtTime(0.001, outEmitTime + 0.012);

      osc.connect(gain);
      gain.connect(this.outputCtx.destination);
      osc.start(outEmitTime);
      osc.stop(outEmitTime + 0.014);
    }

    const msg: MainToWorkletMessage = {
      type: 'start-loopback',
      emitTimesSec: inputEmitTimesSec,
    };
    this.workletNode.port.postMessage(msg);
  }

  /**
   * Cancels an active loopback ping calibration sequence.
   */
  public stopLoopbackPingTest(): void {
    if (!this.workletNode) {
      return;
    }
    const msg: MainToWorkletMessage = {
      type: 'stop-loopback',
    };
    this.workletNode.port.postMessage(msg);
  }
}
