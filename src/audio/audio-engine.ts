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
  type ClickPlacementMode,
  type GroovePatternId,
  isStepAudible,
  type PatternStepDescriptor,
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
import captureWorkletUrl from './capture.worklet.ts?worker&url';
import { StudioDrumSynth } from './drum-synth';

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
  /** Called on every pattern step boundary to animate the Bar Pattern Step Indicator. */
  readonly onStepLamp?: (
    stepInBar: number,
    barNumber: number,
    isSilentGapBar: boolean,
  ) => void;
  /** Called when an automated 6-ping hardware loopback calibration completes. */
  readonly onLoopbackComplete: (summary: LoopbackSummary) => void;
}

/**
 * Manages the dual-`AudioContext` hardware architecture, Web Audio lookahead metronome
 * & synthesized drum scheduler, and sample-accurate loopback calibration.
 *
 * ### Why Two Separate `AudioContext` Instances?
 * In Chromium on macOS/Windows, calling `ctx.createMediaStreamSource(usbInputStream)`
 * binds that `AudioContext`'s hardware clock to the USB input device (e.g. Focusrite Scarlett Solo)
 * and prevents `ctx.setSinkId()` from switching audio output to a different USB DAC
 * (such as a Fosi Audio ZD3).
 *
 * By isolating:
 * - **`inputCtx`** (`setSinkId({ type: 'none' })` + zero-output `AudioWorkletNode`) for
 *   Scarlett Solo capture & DSP analysis, and
 * - **`outputCtx`** (`setSinkId(sinkDeviceId)`) exclusively for click/drum track and sonar ping playback,
 *
 * GrooveLock guarantees zero browser instrument playback echo and instant, hot-swappable
 * output routing across any combination of USB audio interfaces and DACs.
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
  private clickPlacement: ClickPlacementMode = 'all';
  private gapBars: GapClickMode = 0;
  private drillMode: DrillMode = 'free';
  private activeBarTargetNote: TargetNoteEvent['expectedNote'] = 'ANY';

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
   * Updates metronome tempo, subdivision grid, groove pattern, sound engine, click placement,
   * gap-click mode, or note exercise mode.
   */
  public setTransportConfig(config: {
    bpm?: number;
    subdivision?: Subdivision;
    groovePattern?: GroovePatternId;
    soundMode?: SoundEngineMode;
    clickPlacement?: ClickPlacementMode;
    gapBars?: GapClickMode;
    drillMode?: DrillMode;
  }): void {
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
    if (config.clickPlacement !== undefined) {
      this.clickPlacement = config.clickPlacement;
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
   * via `AudioContext.setSinkId()`. Optionally plays a short 1046.5 Hz confirmation tick.
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

  private handleWorkletMessage(msg: WorkletToMainMessage): void {
    if (msg.type === 'meter') {
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
      });
    } else if (msg.type === 'loopback-complete') {
      this.callbacks.onLoopbackComplete(msg.summary);
    }
  }

  /**
   * Starts the Web Audio lookahead metronome scheduler (`25 ms` timer interval, `100 ms` lookahead).
   */
  public startMetronome(): void {
    if (!this.outputCtx || this.isRunning) {
      return;
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

    this.schedulerTimerId = window.setInterval(() => {
      this.runMetronomeScheduler();
    }, 25);
  }

  /**
   * Stops the lookahead metronome scheduler.
   */
  public stopMetronome(): void {
    this.isRunning = false;
    if (this.schedulerTimerId !== null) {
      window.clearInterval(this.schedulerTimerId);
      this.schedulerTimerId = null;
    }
  }

  private runMetronomeScheduler(): void {
    if (!this.outputCtx || !this.isRunning) {
      return;
    }
    const scheduleAheadSec = 0.1;

    while (
      this.nextNoteTimeSec <
      this.outputCtx.currentTime + scheduleAheadSec
    ) {
      const barSteps = resolvePatternBarSteps(
        this.groovePattern,
        this.subdivision,
      );
      if (this.currentStepInBar >= barSteps.length) {
        this.currentStepInBar = 0;
      }

      if (this.currentStepInBar === 0 && this.hasStartedFirstStep) {
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

      this.scheduleStepAudioAndLamps(step, targetEvent);
      if (step.isTargetActive) {
        this.callbacks.onTargetScheduled(targetEvent);
      }

      const secondsPerBeat = 60.0 / this.bpm;
      this.nextNoteTimeSec += secondsPerBeat * step.durationBeats;
      this.currentStepInBar = (this.currentStepInBar + 1) % barSteps.length;
    }
  }

  private scheduleStepAudioAndLamps(
    step: PatternStepDescriptor,
    target: TargetNoteEvent,
  ): void {
    if (!this.outputCtx) {
      return;
    }

    const audible = isStepAudible(
      step,
      this.clickPlacement,
      target.isSilentGapBar,
    );

    if (audible) {
      if (this.soundMode === 'drums') {
        if (step.subIndex === 0) {
          if (step.beatInBar === 0 || step.beatInBar === 2) {
            this.drumSynth.scheduleKick(this.outputCtx, target.timeSec, 0.58);
            this.drumSynth.scheduleHiHat(this.outputCtx, target.timeSec, 0.14);
          } else {
            this.drumSynth.scheduleSnare(this.outputCtx, target.timeSec, 0.42);
            this.drumSynth.scheduleHiHat(this.outputCtx, target.timeSec, 0.16);
          }
        } else {
          this.drumSynth.scheduleHiHat(this.outputCtx, target.timeSec, 0.12);
        }
      } else {
        if (step.subIndex === 0 && step.beatInBar === 0) {
          this.drumSynth.scheduleClick(
            this.outputCtx,
            target.timeSec,
            'downbeat',
          );
        } else if (step.subIndex === 0) {
          this.drumSynth.scheduleClick(
            this.outputCtx,
            target.timeSec,
            'quarter',
          );
        } else {
          this.drumSynth.scheduleClick(
            this.outputCtx,
            target.timeSec,
            'subdivision',
          );
        }
      }
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
      this.callbacks.onStepLamp?.(
        step.stepInBar,
        target.barNumber,
        target.isSilentGapBar,
      );
    }, delayMs);
  }

  /**
   * Emits 6 short 1760 Hz sonar pings on `outputCtx` (spaced 380 ms apart) and instructs
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
    const spacingSec = 0.38;
    const inputEmitTimesSec: number[] = [];

    for (let i = 0; i < numPulses; i++) {
      const outEmitTime = nowOut + 0.35 + i * spacingSec;
      inputEmitTimesSec.push(outEmitTime + clockOffsetToInput);

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
