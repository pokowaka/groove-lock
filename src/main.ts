import './style.css';
import { AudioEngine, type BarScheduleInfo } from './audio/audio-engine';
import { describeBassVoiceNote } from './dsp/pitch-utils';
import type {
  DetectedPluckEvent,
  InputChannelMode,
  InstrumentRange,
  LoopbackSummary,
  MeterSnapshot,
} from './dsp/types';
import {
  type BassGuideMode,
  type ClickPlacementMode,
  type GroovePatternId,
  isBassGuideActiveForBar,
  type PatternStepDescriptor,
  type PocketFeelOffsetMs,
  resolvePatternBarSteps,
  type SoundEngineMode,
  type SpeedTrainerStep,
} from './groove/patterns';
import { type GradedPluckEntry, PocketGrader } from './groove/pocket-grader';
import {
  computeGrooveMeter,
  formatStepName,
  type GrooveTier,
  type HitJudgment,
  judgeHit,
  type RoundHit,
  type RoundSummary,
  StreakTracker,
  stepKeyOf,
  summarizeRound,
} from './groove/scoring';
import {
  type GrooveLockProfile,
  loadProfile,
  type RoundLengthBars,
  saveProfile,
  type VisualGuideMode,
} from './groove/storage';
import { computeTapTempoBpm, TAP_RESET_GAP_MS } from './groove/tap-tempo';
import {
  computeBarTarget,
  type DrillMode,
  type GapClickMode,
  type Subdivision,
  type TargetNoteEvent,
} from './groove/timeline';
import { bindSegmented, DrawerController, type SegmentedControl } from './ui/controls';
import { DemoPlayer } from './ui/demo-player';
import { PocketMeter } from './ui/pocket-meter';
import { HEAT_MIN_HITS, type LanePhase, TimelineLane } from './ui/timeline-lane';

const MIN_BPM = 40;
const MAX_BPM = 200;
const AUTO_CONTINUE_SEC = 6;
const SESSION_HISTORY_LIMIT = 400;
const STEP_HEAT_WINDOW = 16;

const GROOVE_TIER_LABELS: Readonly<Record<GrooveTier, string>> = {
  machine: 'Machine',
  tight: 'Tight',
  solid: 'Solid',
  loose: 'Loose',
  wobbly: 'Wobbly',
};

const JUDGMENT_LABELS: Readonly<Record<HitJudgment, string>> = {
  locked: 'Locked',
  pocket: 'In the pocket',
  rushed: '← Rushed',
  dragged: 'Dragged →',
};

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing required DOM element #${id}`);
  }
  return el as T;
}

function formatSignedMs(ms: number, digits = 1): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '±';
  return `${sign}${Math.abs(ms).toFixed(digits)} ms`;
}

function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

/**
 * Builds the one-line exercise description shown on the transport's Exercise chip.
 */
function formatExerciseSummary(p: GrooveLockProfile): string {
  const grid: Record<Subdivision, string> = {
    1: 'Quarter notes',
    2: '8th notes',
    3: 'Triplets',
    4: '16th notes',
  };
  const patterns: Record<GroovePatternId, string> = {
    uniform: grid[p.subdivision],
    'motown-pocket': 'Motown pocket',
    'funk-16th': 'Funk 16ths',
    'shuffle-swing': 'Shuffle',
    'octaves-8th': '8th octaves',
  };
  const parts = [patterns[p.groovePattern]];
  if (p.soundMode === 'drums') parts.push('Drums');
  const clicks: Record<ClickPlacementMode, string | null> = {
    all: null,
    'backbeat-2-4': 'Click on 2 & 4',
    'one-drop-1': 'Click on 1',
    'offbeat-and': 'Click on &s',
  };
  const click = clicks[p.clickPlacement];
  if (click) parts.push(click);
  if (p.gapBars === 1) parts.push('3+1 silent');
  if (p.gapBars === 2) parts.push('2+2 silent');
  if (p.pocketCenterMs > 0) parts.push('Laid back');
  if (p.pocketCenterMs < 0) parts.push('Pushed');
  const guides: Record<BassGuideMode, string | null> = {
    off: null,
    always: 'Bass along',
    'demo-first': 'Demo first',
    'call-response-1-1': 'Echo 1:1',
    'call-response-1-3': 'Echo 1:3',
  };
  const guide = guides[p.bassGuideMode];
  if (guide) parts.push(guide);
  const drills: Record<DrillMode, string | null> = {
    free: null,
    'root-cycle': 'Cycle of 4ths',
    'random-bar': 'Random notes',
    'fixed-e': 'On E',
    'fixed-a': 'On A',
  };
  const drill = drills[p.drillMode];
  if (drill) parts.push(drill);
  if (p.speedTrainerStep > 0) parts.push(`Auto +${p.speedTrainerStep}`);
  parts.push(p.roundBars === 0 ? 'Endless' : `${p.roundBars}-bar rounds`);
  return parts.join(' · ');
}

function bootstrapGrooveLock(): void {
  const dom = {
    playBtn: requireEl<HTMLButtonElement>('play-btn'),
    playLabel: requireEl<HTMLSpanElement>('play-label'),
    bpmDown: requireEl<HTMLButtonElement>('bpm-down'),
    bpmUp: requireEl<HTMLButtonElement>('bpm-up'),
    bpmValue: requireEl<HTMLSpanElement>('bpm-value'),
    tapBtn: requireEl<HTMLButtonElement>('tap-btn'),
    exerciseChip: requireEl<HTMLButtonElement>('exercise-chip'),
    exerciseSummary: requireEl<HTMLSpanElement>('exercise-summary'),
    setupChip: requireEl<HTMLButtonElement>('setup-chip'),
    audioLed: requireEl<HTMLSpanElement>('audio-led'),
    audioStatusText: requireEl<HTMLSpanElement>('audio-status-text'),

    phaseTag: requireEl<HTMLSpanElement>('phase-tag'),
    barCounter: requireEl<HTMLSpanElement>('bar-counter'),
    laneTarget: requireEl<HTMLSpanElement>('lane-target'),
    bassLineBtn: requireEl<HTMLButtonElement>('bass-line-btn'),
    timelineCanvas: requireEl<HTMLCanvasElement>('timeline-canvas'),
    laneOverlay: requireEl<HTMLDivElement>('lane-overlay'),
    overlayTitle: requireEl<HTMLDivElement>('overlay-title'),
    overlaySub: requireEl<HTMLDivElement>('overlay-sub'),

    lastOffset: requireEl<HTMLDivElement>('last-offset'),
    judgment: requireEl<HTMLDivElement>('judgment'),
    readoutSub: requireEl<HTMLDivElement>('readout-sub'),
    pocketCanvas: requireEl<HTMLCanvasElement>('pocket-canvas'),
    grooveTier: requireEl<HTMLDivElement>('groove-tier'),
    grooveFill: requireEl<HTMLDivElement>('groove-fill'),
    grooveSigma: requireEl<HTMLSpanElement>('groove-sigma'),
    streakCurrent: requireEl<HTMLElement>('streak-current'),
    streakBest: requireEl<HTMLElement>('streak-best'),

    targetNote: requireEl<HTMLSpanElement>('target-note'),
    targetSub: requireEl<HTMLSpanElement>('target-sub'),
    detectedNote: requireEl<HTMLSpanElement>('detected-note'),
    detectedSub: requireEl<HTMLSpanElement>('detected-sub'),
    centsNeedle: requireEl<HTMLDivElement>('cents-needle'),
    statPocket: requireEl<HTMLSpanElement>('stat-pocket'),
    statMean: requireEl<HTMLSpanElement>('stat-mean'),
    statSigma: requireEl<HTMLSpanElement>('stat-sigma'),
    statCount: requireEl<HTMLSpanElement>('stat-count'),
    statNotes: requireEl<HTMLSpanElement>('stat-notes'),

    results: requireEl<HTMLDivElement>('results'),
    resultsStars: requireEl<HTMLDivElement>('results-stars'),
    resPocket: requireEl<HTMLSpanElement>('res-pocket'),
    resSigma: requireEl<HTMLSpanElement>('res-sigma'),
    resMean: requireEl<HTMLSpanElement>('res-mean'),
    resStreak: requireEl<HTMLSpanElement>('res-streak'),
    resTip: requireEl<HTMLParagraphElement>('res-tip'),
    resTempo: requireEl<HTMLParagraphElement>('res-tempo'),
    resNext: requireEl<HTMLButtonElement>('res-next'),
    resStay: requireEl<HTMLButtonElement>('res-stay'),
    countdown: requireEl<HTMLDivElement>('countdown'),
    countdownFill: requireEl<HTMLDivElement>('countdown-fill'),
    countdownText: requireEl<HTMLSpanElement>('countdown-text'),

    drawerScrim: requireEl<HTMLDivElement>('drawer-scrim'),
    exerciseDrawer: requireEl<HTMLElement>('exercise-drawer'),
    setupDrawer: requireEl<HTMLElement>('setup-drawer'),
    groovePatternSelect: requireEl<HTMLSelectElement>('groove-pattern-select'),
    subdivisionHelp: requireEl<HTMLSpanElement>('subdivision-help'),
    drillModeSelect: requireEl<HTMLSelectElement>('drill-mode-select'),
    bassGuideHelp: requireEl<HTMLSpanElement>('bass-guide-help'),

    connectAudioBtn: requireEl<HTMLButtonElement>('connect-audio-btn'),
    deviceSelect: requireEl<HTMLSelectElement>('audio-device-select'),
    outputDeviceSelect: requireEl<HTMLSelectElement>('audio-output-select'),
    outputSinkStatus: requireEl<HTMLSpanElement>('output-sink-status'),
    channelSelect: requireEl<HTMLSelectElement>('input-channel-select'),
    sampleRateLabel: requireEl<HTMLSpanElement>('sample-rate-label'),
    peakDbReadout: requireEl<HTMLSpanElement>('peak-db-readout'),
    meterCh1: requireEl<HTMLDivElement>('meter-ch1'),
    meterCh2: requireEl<HTMLDivElement>('meter-ch2'),
    thresholdMarker1: requireEl<HTMLDivElement>('threshold-marker-1'),
    thresholdMarker2: requireEl<HTMLDivElement>('threshold-marker-2'),
    thresholdSlider: requireEl<HTMLInputElement>('onset-threshold-slider'),
    thresholdValueLabel: requireEl<HTMLSpanElement>('threshold-value-label'),
    latencySlider: requireEl<HTMLInputElement>('latency-offset-slider'),
    latencyValueLabel: requireEl<HTMLSpanElement>('latency-value-label'),
    loopbackPingBtn: requireEl<HTMLButtonElement>('loopback-ping-btn'),
    calibrateBtn: requireEl<HTMLButtonElement>('calibrate-btn'),
    calibrationStatus: requireEl<HTMLParagraphElement>('calibration-status'),
  };

  const isDemo = new URLSearchParams(window.location.search).has('demo');
  const profile: GrooveLockProfile = loadProfile();
  const grader = new PocketGrader();
  const streak = new StreakTracker();
  const drawers = new DrawerController(dom.drawerScrim);

  let laneSteps: readonly PatternStepDescriptor[] = [];
  let currentBarExpectedNote: TargetNoteEvent['expectedNote'] =
    computeBarTarget(profile.drillMode, 0).targetNote;
  let sessionOffsetsMs: number[] = [];
  let stepFeelHistory = new Map<string, number[]>();

  let isRoundActive = false;
  let roundHits: RoundHit[] = [];
  let roundExpectedTargets = 0;
  let lastSummary: RoundSummary | null = null;
  let countdownTimerId: number | null = null;
  let tapTimesMs: number[] = [];

  let isCalibrating = false;
  let calibrationOffsetsMs: number[] = [];
  let isLoopbackPinging = false;

  const engine = new AudioEngine({
    onMeter: handleMeterSnapshot,
    onPluck: handlePluckEvent,
    onTargetScheduled: handleTargetScheduled,
    onBeatLamp: () => {},
    onStepLamp: handleStepLamp,
    onLoopbackComplete: handleLoopbackComplete,
    onBarScheduled: handleBarScheduled,
    onCountInBeat: handleCountInBeat,
    onRoundComplete: handleRoundComplete,
  });

  const lane = new TimelineLane(dom.timelineCanvas, () => engine.getAudioClockSec());
  const pocketMeter = new PocketMeter(dom.pocketCanvas);

  const demoPlayer = isDemo
    ? new DemoPlayer({
        deliver: handlePluckEvent,
        readClock: () => engine.getAudioClockSec(),
        readLatencyMs: () => profile.latencyCompensationMs,
        readRange: () => profile.instrumentRange,
      })
    : null;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function persist(): void {
    saveProfile(profile);
  }

  function effectiveRoundBars(): number {
    return isCalibrating ? 0 : profile.roundBars;
  }

  /** `true` when reference-bass bars are demos to listen to (not played along with or graded). */
  function isCallResponseMode(): boolean {
    return (
      profile.bassGuideMode === 'call-response-1-1' ||
      profile.bassGuideMode === 'call-response-1-3' ||
      profile.bassGuideMode === 'demo-first'
    );
  }

  /** Explains the listen/play structure of the selected reference bass mode for this round length. */
  function updateBassGuideHelp(): void {
    const n = profile.roundBars;
    const rounds = n === 0 ? 'each start' : `each ${n}-bar round`;
    const texts: Record<BassGuideMode, string> = {
      off: 'No reference bass. Just you and the groove.',
      'demo-first':
        n === 0
          ? 'Listen to 1 bar, then you play every bar after.'
          : `Listen to 1 bar, then you play ${n - 1} bars. Repeats ${rounds}.`,
      always: 'The bass plays with you the whole time (not a demo, all bars graded).',
      'call-response-1-3': 'Listen 1 bar, play 3, repeat.',
      'call-response-1-1': 'Listen 1 bar, play 1, repeat.',
    };
    let text = texts[profile.bassGuideMode];
    if (profile.bassGuideMode !== 'off' && profile.bassGuideMode !== 'always' && profile.soundMode === 'click') {
      text += ' Tip: pick Drums so a groove keeps going while you play.';
    }
    dom.bassGuideHelp.textContent = text;
  }

  function isListenBar(barNumber: number): boolean {
    return isCallResponseMode() && isBassGuideActiveForBar(barNumber, profile.bassGuideMode);
  }

  const segmented = new Map<string, SegmentedControl>();

  function onSettingChanged(setting: string, raw: string): void {
    switch (setting) {
      case 'subdivision':
        profile.subdivision = Number(raw) as Subdivision;
        grader.clearTimeline();
        engine.setTransportConfig({ subdivision: profile.subdivision });
        rebuildLane();
        break;
      case 'soundMode':
        profile.soundMode = raw as SoundEngineMode;
        engine.setTransportConfig({ soundMode: profile.soundMode });
        break;
      case 'bassGuideMode':
        profile.bassGuideMode = raw as BassGuideMode;
        engine.setTransportConfig({ bassGuideMode: profile.bassGuideMode });
        syncBassLineButton();
        updateTargetDisplay(engine.getCurrentBarNumber());
        break;
      case 'clickPlacement':
        profile.clickPlacement = raw as ClickPlacementMode;
        engine.setTransportConfig({ clickPlacement: profile.clickPlacement });
        break;
      case 'gapBars':
        profile.gapBars = Number(raw) as GapClickMode;
        engine.setTransportConfig({ gapBars: profile.gapBars });
        break;
      case 'speedTrainerStep':
        profile.speedTrainerStep = Number(raw) as SpeedTrainerStep;
        grader.resetSpeedTrainerWindow();
        break;
      case 'pocketCenterMs':
        profile.pocketCenterMs = Number(raw) as PocketFeelOffsetMs;
        engine.setTransportConfig({ pocketCenterMs: profile.pocketCenterMs });
        applyPocketSettings();
        break;
      case 'pocketWindowMs':
        profile.pocketWindowMs = Number(raw);
        applyPocketSettings();
        break;
      case 'instrumentRange':
        profile.instrumentRange = raw as InstrumentRange;
        engine.setDspConfig({ instrumentRange: profile.instrumentRange });
        refreshNoteLabels();
        updateTargetDisplay(engine.getCurrentBarNumber());
        break;
      case 'roundBars':
        profile.roundBars = Number(raw) as RoundLengthBars;
        engine.setTransportConfig({ roundBars: effectiveRoundBars() });
        if (!engine.isMetronomeRunning()) {
          setBarCounterIdle();
        }
        break;
      case 'autoContinue':
        profile.autoContinue = raw === 'true';
        break;
      case 'visualGuide':
        profile.visualGuide = raw as VisualGuideMode;
        lane.setGuide(profile.visualGuide);
        break;
    }
    persist();
    updateExerciseSummary();
    updateBassGuideHelp();
  }

  document.querySelectorAll<HTMLElement>('.segmented[data-setting]').forEach((el) => {
    const setting = el.dataset.setting ?? '';
    segmented.set(
      setting,
      bindSegmented(el, (value) => onSettingChanged(setting, value)),
    );
  });

  function syncSegmentedFromProfile(): void {
    const values: Record<string, string> = {
      subdivision: String(profile.subdivision),
      soundMode: profile.soundMode,
      bassGuideMode: profile.bassGuideMode,
      clickPlacement: profile.clickPlacement,
      gapBars: String(profile.gapBars),
      speedTrainerStep: String(profile.speedTrainerStep),
      pocketCenterMs: String(profile.pocketCenterMs),
      pocketWindowMs: String(profile.pocketWindowMs),
      instrumentRange: profile.instrumentRange,
      roundBars: String(profile.roundBars),
      autoContinue: String(profile.autoContinue),
      visualGuide: profile.visualGuide,
    };
    for (const [setting, value] of Object.entries(values)) {
      segmented.get(setting)?.set(value);
    }
  }

  function updateExerciseSummary(): void {
    const summary = formatExerciseSummary(profile);
    dom.exerciseSummary.textContent = summary;
    dom.exerciseChip.title = summary;
  }

  function applyPocketSettings(): void {
    lane.setPocketWindow(profile.pocketWindowMs);
    pocketMeter.setPocket(profile.pocketCenterMs, profile.pocketWindowMs);
    renderSessionStats();
    dom.readoutSub.textContent = describeFeelTarget();
  }

  function describeFeelTarget(): string {
    if (profile.pocketCenterMs > 0) {
      return `vs. laid-back target (+${profile.pocketCenterMs} ms)`;
    }
    if (profile.pocketCenterMs < 0) {
      return `vs. pushed target (${profile.pocketCenterMs} ms)`;
    }
    return 'vs. the grid';
  }

  function setBpm(bpm: number): void {
    const next = clampBpm(bpm);
    if (next === profile.bpm) {
      return;
    }
    profile.bpm = next;
    persist();
    dom.bpmValue.textContent = String(profile.bpm);
    engine.setTransportConfig({ bpm: profile.bpm });
  }

  function handleTap(): void {
    const now = performance.now();
    const last = tapTimesMs[tapTimesMs.length - 1];
    if (last !== undefined && now - last > TAP_RESET_GAP_MS) {
      tapTimesMs = [];
    }
    tapTimesMs.push(now);
    tapTimesMs = tapTimesMs.slice(-8);
    const bpm = computeTapTempoBpm(tapTimesMs);
    if (bpm !== null) {
      setBpm(bpm);
    }
  }

  // ---------------------------------------------------------------------------
  // Lane & target note
  // ---------------------------------------------------------------------------

  function noteLabelsFor(
    steps: readonly PatternStepDescriptor[],
    note: TargetNoteEvent['expectedNote'],
  ): string[] {
    return steps.map((step) => {
      if (!step.isTargetActive) {
        return '';
      }
      if (note === 'ANY' && profile.bassGuideMode === 'off') {
        return '';
      }
      return describeBassVoiceNote(note, profile.instrumentRange, step.octaveShift).fullName;
    });
  }

  function rebuildLane(): void {
    laneSteps = resolvePatternBarSteps(profile.groovePattern, profile.subdivision);
    lane.setSteps(laneSteps, noteLabelsFor(laneSteps, currentBarExpectedNote));
    stepFeelHistory = new Map();
    const disabled = profile.groovePattern !== 'uniform';
    segmented.get('subdivision')?.setDisabled(disabled);
    dom.subdivisionHelp.hidden = !disabled;
  }

  function refreshNoteLabels(): void {
    lane.setNoteLabels(noteLabelsFor(laneSteps, currentBarExpectedNote));
  }

  function updateTargetDisplay(barNumber: number, overrideNote?: TargetNoteEvent['expectedNote']): void {
    const note = overrideNote ?? computeBarTarget(profile.drillMode, barNumber).targetNote;
    if (note !== currentBarExpectedNote) {
      currentBarExpectedNote = note;
      refreshNoteLabels();
    }
    dom.targetNote.classList.remove('is-match', 'is-miss');
    if (note === 'ANY') {
      dom.targetNote.textContent = 'Any';
      dom.targetSub.textContent =
        profile.bassGuideMode === 'off'
          ? 'Free groove'
          : `Bass plays ${describeBassVoiceNote(note, profile.instrumentRange).fullName}`;
      dom.laneTarget.textContent = 'Any note';
      return;
    }
    const voice = describeBassVoiceNote(note, profile.instrumentRange);
    dom.targetNote.textContent = voice.fullName;
    dom.targetSub.textContent = voice.fretboardHint;
    dom.laneTarget.textContent = `Play ${voice.fullName}`;
  }

  function phaseOf(info: BarScheduleInfo): LanePhase {
    if (info.kind === 'count-in') return 'count-in';
    if (isListenBar(info.barNumber)) return 'listen';
    if (info.isSilentGapBar) return 'silent';
    return 'play';
  }

  function setPhaseTag(phase: LanePhase | 'ready', text?: string): void {
    const labels: Record<LanePhase | 'ready', string> = {
      ready: 'Ready',
      'count-in': 'Count-in',
      play: 'Your turn',
      listen: 'Listen',
      silent: 'Silent bar',
    };
    dom.phaseTag.dataset.phase = phase;
    dom.phaseTag.textContent = text ?? labels[phase];
  }

  function setBarCounterIdle(): void {
    dom.barCounter.textContent =
      profile.roundBars === 0 ? 'Endless' : `${profile.roundBars}-bar rounds`;
  }

  function showOverlay(title: string, sub: string): void {
    dom.overlayTitle.innerHTML = '';
    const parts = title.split('Space');
    parts.forEach((part, i) => {
      dom.overlayTitle.append(part);
      if (i < parts.length - 1) {
        const kbd = document.createElement('kbd');
        kbd.textContent = 'Space';
        dom.overlayTitle.append(kbd);
      }
    });
    dom.overlaySub.textContent = sub;
    dom.laneOverlay.classList.remove('is-hidden');
  }

  function hideOverlay(): void {
    dom.laneOverlay.classList.add('is-hidden');
  }

  // ---------------------------------------------------------------------------
  // Audio device setup
  // ---------------------------------------------------------------------------

  function updateThresholdMarkers(): void {
    const pct = Math.min(100, Math.max(0, (profile.onsetThreshold / 0.2) * 100));
    dom.thresholdMarker1.style.left = `${pct.toFixed(1)}%`;
    dom.thresholdMarker2.style.left = `${pct.toFixed(1)}%`;
    dom.thresholdValueLabel.textContent = profile.onsetThreshold.toFixed(3);
  }

  function setLatency(ms: number): void {
    profile.latencyCompensationMs = ms;
    persist();
    dom.latencySlider.value = String(ms);
    dom.latencyValueLabel.textContent = `${ms} ms`;
  }

  function populateDeviceDropdowns(
    inputs: readonly MediaDeviceInfo[],
    outputs: readonly MediaDeviceInfo[],
    resolvedInputId: string,
    resolvedOutputId: string,
  ): void {
    dom.deviceSelect.replaceChildren();
    inputs.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Audio input ${idx + 1}`;
      opt.selected = dev.deviceId === resolvedInputId;
      dom.deviceSelect.appendChild(opt);
    });

    dom.outputDeviceSelect.replaceChildren();
    const defaultOut = document.createElement('option');
    defaultOut.value = '';
    defaultOut.textContent = 'System default output';
    dom.outputDeviceSelect.appendChild(defaultOut);
    outputs.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Audio output ${idx + 1}`;
      opt.selected = dev.deviceId === resolvedOutputId;
      dom.outputDeviceSelect.appendChild(opt);
    });
  }

  async function applyOutputSinkSelection(sinkDeviceId: string, tick: boolean): Promise<void> {
    const status = await engine.applyOutputDevice(sinkDeviceId, tick);
    const labels: Record<typeof status, string> = {
      direct: 'Direct',
      default: 'System default',
      unsupported: 'macOS default',
      error: 'Fallback default',
    };
    dom.outputSinkStatus.textContent = labels[status];
  }

  async function connectAudioInterface(requestedDeviceId: string): Promise<boolean> {
    try {
      dom.audioStatusText.textContent = 'Connecting…';
      dom.audioLed.className = 'led-dot warn';
      const lists = await engine.connectInput(requestedDeviceId, profile.selectedOutputDeviceId);
      profile.selectedDeviceId = lists.resolvedInputId;
      if (!profile.selectedOutputDeviceId && lists.resolvedOutputId) {
        profile.selectedOutputDeviceId = lists.resolvedOutputId;
      }
      persist();
      populateDeviceDropdowns(
        lists.inputs,
        lists.outputs,
        profile.selectedDeviceId,
        profile.selectedOutputDeviceId,
      );
      await applyOutputSinkSelection(profile.selectedOutputDeviceId, false);
      const sr = engine.getOutputSampleRate();
      dom.sampleRateLabel.textContent = sr ? `${(sr / 1000).toFixed(1)} kHz` : '';
      const inputLabel = lists.inputs.find((d) => d.deviceId === lists.resolvedInputId)?.label ?? '';
      dom.audioLed.className = 'led-dot active';
      dom.audioStatusText.textContent = /scarlett|focusrite/i.test(inputLabel) ? 'Scarlett live' : 'Input live';
      dom.connectAudioBtn.textContent = 'Reconnect audio input';
      dom.loopbackPingBtn.disabled = false;
      dom.calibrateBtn.disabled = false;
      return true;
    } catch {
      dom.audioLed.className = 'led-dot warn';
      dom.audioStatusText.textContent = 'Input blocked';
      return false;
    }
  }

  function handleMeterSnapshot(snapshot: MeterSnapshot): void {
    dom.meterCh1.style.width = `${Math.min(100, (snapshot.rmsCh0 / 0.2) * 100).toFixed(1)}%`;
    dom.meterCh2.style.width = `${Math.min(100, (snapshot.rmsCh1 / 0.2) * 100).toFixed(1)}%`;
    dom.peakDbReadout.textContent =
      snapshot.activeRms > 0.0001 ? `${(20 * Math.log10(snapshot.activeRms)).toFixed(1)} dB` : '−∞ dB';
  }

  // ---------------------------------------------------------------------------
  // Transport & rounds
  // ---------------------------------------------------------------------------

  function setPlayButton(playing: boolean): void {
    dom.playBtn.classList.toggle('is-playing', playing);
    dom.playLabel.textContent = playing ? 'Stop' : 'Play';
    dom.playBtn.querySelector('.play-icon')!.textContent = playing ? '■' : '▶';
  }

  async function startPlaying(): Promise<void> {
    cancelCountdown();
    dom.results.hidden = true;
    if (!isDemo && !engine.isInputConnected()) {
      await connectAudioInterface(dom.deviceSelect.value || profile.selectedDeviceId);
    }
    roundHits = [];
    roundExpectedTargets = 0;
    isRoundActive = effectiveRoundBars() > 0;
    grader.clearTimeline();
    lane.clearBars();
    engine.setTransportConfig({ roundBars: effectiveRoundBars(), countInBars: 1 });
    engine.startMetronome();
    setPlayButton(true);
    hideOverlay();
    setPhaseTag('count-in');
    dom.barCounter.textContent = 'Get ready';
  }

  function stopPlaying(): void {
    engine.stopMetronome();
    isRoundActive = false;
    cancelCountdown();
    dom.results.hidden = true;
    lane.clearBars();
    setPlayButton(false);
    setPhaseTag('ready');
    setBarCounterIdle();
    showOverlay('Paused — press Space to play', 'Your session stats are kept. Press R to reset.');
  }

  function togglePlay(): void {
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    } else {
      void startPlaying();
    }
  }

  function handleRoundComplete(): void {
    isRoundActive = false;
    setPlayButton(false);
    setPhaseTag('ready', 'Round done');
    lane.clearBars();

    const summary = summarizeRound(roundHits, {
      pocketWindowMs: profile.pocketWindowMs,
      expectedTargetCount: roundExpectedTargets,
    });
    lastSummary = summary;

    let tempoMessage: string | null = null;
    if (summary.stars === 3 && profile.speedTrainerStep > 0 && profile.bpm < MAX_BPM) {
      setBpm(profile.bpm + profile.speedTrainerStep);
      tempoMessage = `Tempo up → ${profile.bpm} BPM next round`;
    }
    showResults(summary, tempoMessage);
  }

  function showResults(summary: RoundSummary, tempoMessage: string | null): void {
    dom.resultsStars.replaceChildren();
    for (let i = 0; i < 3; i++) {
      const star = document.createElement('span');
      star.textContent = '★';
      if (i < summary.stars) star.className = 'on';
      dom.resultsStars.appendChild(star);
    }
    dom.resultsStars.setAttribute('aria-label', `${summary.stars} of 3 stars`);
    dom.resPocket.textContent = `${summary.inPocketPct}%`;
    dom.resSigma.textContent = summary.sigmaMs === null ? '—' : `${summary.sigmaMs.toFixed(1)} ms`;
    dom.resMean.textContent =
      summary.meanFeelDeltaMs === null ? '—' : formatSignedMs(summary.meanFeelDeltaMs);
    dom.resStreak.textContent = String(summary.bestStreak);
    dom.resTip.textContent = summary.tip;
    dom.resTempo.hidden = tempoMessage === null;
    dom.resTempo.textContent = tempoMessage ?? '';
    dom.results.hidden = false;

    dom.countdown.hidden = !profile.autoContinue;
    if (profile.autoContinue) {
      startCountdown();
    }
  }

  function startCountdown(): void {
    cancelCountdown();
    const startMs = performance.now();
    const tick = (): void => {
      const elapsedSec = (performance.now() - startMs) / 1000;
      const remaining = Math.max(0, AUTO_CONTINUE_SEC - elapsedSec);
      dom.countdownFill.style.transform = `scaleX(${(remaining / AUTO_CONTINUE_SEC).toFixed(3)})`;
      dom.countdownText.textContent = `Next round in ${Math.ceil(remaining)} s`;
      if (remaining <= 0) {
        cancelCountdown();
        void startPlaying();
      }
    };
    tick();
    countdownTimerId = window.setInterval(tick, 100);
  }

  function cancelCountdown(): void {
    if (countdownTimerId !== null) {
      window.clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
  }

  function stayAfterRound(): void {
    cancelCountdown();
    dom.results.hidden = true;
    const s = lastSummary;
    const stars = s ? '★'.repeat(s.stars) + '☆'.repeat(3 - s.stars) : '';
    showOverlay(
      'Press Space for the next round',
      s ? `Last round ${stars} · ${s.inPocketPct}% in pocket` : '',
    );
    setPhaseTag('ready');
    setBarCounterIdle();
  }

  function handleBarScheduled(info: BarScheduleInfo): void {
    lane.pushBar(info, phaseOf(info));
  }

  function handleCountInBeat(beatInBar: number): void {
    setPhaseTag('count-in', `Count-in · ${beatInBar + 1}`);
  }

  function handleTargetScheduled(event: TargetNoteEvent): void {
    if (isListenBar(event.barNumber)) {
      return;
    }
    grader.pushTargetEvent(event);
    roundExpectedTargets++;
    demoPlayer?.onTarget(event);

    if (
      event.beatInBar === 0 &&
      event.subIndex === 0 &&
      effectiveRoundBars() === 0 &&
      profile.speedTrainerStep > 0 &&
      grader.consumeSpeedTrainerStepUpIfReady(4, 0.85)
    ) {
      setBpm(profile.bpm + profile.speedTrainerStep);
    }
  }

  function handleStepLamp(step: PatternStepDescriptor, target: TargetNoteEvent): void {
    if (step.stepInBar !== 0) {
      return;
    }
    const n = target.barNumber + 1;
    dom.barCounter.textContent =
      effectiveRoundBars() > 0 ? `Bar ${n} / ${effectiveRoundBars()}` : `Bar ${n}`;
    setPhaseTag(
      isListenBar(target.barNumber) ? 'listen' : target.isSilentGapBar ? 'silent' : 'play',
    );
    updateTargetDisplay(target.barNumber, target.expectedNote);
  }

  // ---------------------------------------------------------------------------
  // Plucks & grading
  // ---------------------------------------------------------------------------

  function handlePluckEvent(pluck: DetectedPluckEvent): void {
    renderDetectedNote(pluck);
    if (!engine.isMetronomeRunning()) {
      return;
    }
    if (isCalibrating) {
      recordCalibrationHit(pluck.rawOnsetTimeSec);
      return;
    }
    const graded = grader.evaluatePluck(pluck, {
      latencyCompensationMs: profile.latencyCompensationMs,
      bpm: profile.bpm,
      subdivision: engine.getEffectiveSubdivision(),
      pocketWindowMs: profile.pocketWindowMs,
      pocketCenterMs: profile.pocketCenterMs,
    });
    if (graded) {
      handleGradedHit(graded);
    }
  }

  function renderDetectedNote(pluck: DetectedPluckEvent): void {
    if (!pluck.pitch) {
      dom.detectedNote.textContent = 'X';
      dom.detectedSub.textContent = 'Muted / ghost note';
      return;
    }
    const cents = pluck.pitch.cents;
    dom.detectedNote.textContent = pluck.pitch.fullName;
    dom.detectedSub.textContent = `${cents >= 0 ? '+' : ''}${cents}¢ · ${pluck.pitch.freqHz.toFixed(1)} Hz`;
    const clamped = Math.max(-50, Math.min(50, cents));
    dom.centsNeedle.style.left = `${50 + clamped}%`;
    dom.centsNeedle.style.backgroundColor =
      Math.abs(cents) <= 10 ? 'var(--accent-locked)' : 'var(--accent-amber)';
  }

  function handleGradedHit(entry: GradedPluckEntry): void {
    const judgment = judgeHit(entry.feelDeltaMs, profile.pocketWindowMs);
    const t = entry.targetEvent;
    const subdivision = engine.getEffectiveSubdivision();
    const key = stepKeyOf(t.beatInBar, t.subIndex);

    dom.lastOffset.textContent = formatSignedMs(entry.feelDeltaMs);
    dom.lastOffset.dataset.judgment = judgment;
    dom.judgment.textContent = JUDGMENT_LABELS[judgment];
    dom.judgment.dataset.judgment = judgment;
    dom.readoutSub.textContent =
      profile.pocketCenterMs === 0
        ? describeFeelTarget()
        : `${describeFeelTarget()} · grid ${formatSignedMs(entry.offsetMs)}`;

    if (entry.targetNote !== 'ANY') {
      dom.targetNote.classList.toggle('is-match', entry.noteMatched);
      dom.targetNote.classList.toggle('is-miss', !entry.noteMatched);
    }

    streak.record(entry.inPocket && entry.noteMatched);
    sessionOffsetsMs.push(entry.offsetMs);
    if (sessionOffsetsMs.length > SESSION_HISTORY_LIMIT) {
      sessionOffsetsMs.shift();
    }

    const history = stepFeelHistory.get(key) ?? [];
    history.push(entry.feelDeltaMs);
    stepFeelHistory.set(key, history.slice(-STEP_HEAT_WINDOW));

    const stepIndex = laneSteps.findIndex(
      (s) => s.beatInBar === t.beatInBar && s.subIndex === t.subIndex,
    );
    if (stepIndex >= 0) {
      lane.recordHit(stepIndex, judgment);
      lane.setHeat(
        laneSteps.map((s) => {
          const h = stepFeelHistory.get(stepKeyOf(s.beatInBar, s.subIndex));
          return h && h.length >= HEAT_MIN_HITS ? h.reduce((a, v) => a + v, 0) / h.length : null;
        }),
      );
    }
    pocketMeter.addHit({ offsetMs: entry.offsetMs, judgment });

    if (isRoundActive) {
      roundHits.push({
        stepKey: key,
        stepName: formatStepName(t.beatInBar, t.subIndex, subdivision),
        offsetMs: entry.offsetMs,
        feelDeltaMs: entry.feelDeltaMs,
        inPocket: entry.inPocket,
        noteMatched: entry.noteMatched,
      });
    }

    renderGrooveMeter();
    renderSessionStats();
  }

  function renderGrooveMeter(): void {
    const reading = computeGrooveMeter(sessionOffsetsMs);
    if (reading.tier === null || reading.sigmaMs === null) {
      dom.grooveTier.textContent = '—';
      delete dom.grooveTier.dataset.tier;
      dom.grooveFill.style.width = '0%';
      dom.grooveSigma.textContent = 'σ — ms';
    } else {
      dom.grooveTier.textContent = GROOVE_TIER_LABELS[reading.tier];
      dom.grooveTier.dataset.tier = reading.tier;
      dom.grooveFill.style.width = `${(reading.fill * 100).toFixed(0)}%`;
      dom.grooveFill.style.backgroundColor = getComputedStyle(dom.grooveTier).color;
      dom.grooveSigma.textContent = `σ ${reading.sigmaMs.toFixed(1)} ms`;
    }
    dom.streakCurrent.textContent = String(streak.current);
    dom.streakBest.textContent = String(streak.best);
  }

  function renderSessionStats(): void {
    const stats = grader.getStats(profile.pocketWindowMs, profile.pocketCenterMs);
    dom.statCount.textContent = String(stats.totalHits);
    if (stats.inPocketPct === null || stats.meanOffsetMs === null || stats.stdDevMs === null) {
      dom.statPocket.textContent = '—';
      dom.statMean.textContent = '—';
      dom.statSigma.textContent = '—';
      dom.statNotes.textContent = '—';
      return;
    }
    dom.statPocket.textContent = `${stats.inPocketPct}%`;
    dom.statMean.textContent = formatSignedMs(stats.meanOffsetMs - profile.pocketCenterMs);
    dom.statSigma.textContent = `${stats.stdDevMs.toFixed(1)} ms`;
    dom.statNotes.textContent =
      stats.noteAttempts > 0
        ? `${Math.round((stats.noteMatches / stats.noteAttempts) * 100)}%`
        : 'Free';
  }

  function resetSession(): void {
    grader.resetStats();
    streak.reset();
    sessionOffsetsMs = [];
    stepFeelHistory = new Map();
    lane.resetHits();
    pocketMeter.clear();
    dom.lastOffset.textContent = '—';
    delete dom.lastOffset.dataset.judgment;
    dom.judgment.textContent = 'Waiting';
    delete dom.judgment.dataset.judgment;
    dom.readoutSub.textContent = describeFeelTarget();
    renderGrooveMeter();
    renderSessionStats();
  }

  // ---------------------------------------------------------------------------
  // Calibration
  // ---------------------------------------------------------------------------

  function startTapCalibration(): void {
    isLoopbackPinging = false;
    engine.stopLoopbackPingTest();
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
    isCalibrating = true;
    calibrationOffsetsMs = [];
    dom.calibrationStatus.textContent = 'Pluck right on every click… (0 / 8)';
    void startPlaying();
  }

  function finishCalibration(message: string): void {
    isCalibrating = false;
    dom.calibrationStatus.textContent = message;
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
  }

  function recordCalibrationHit(rawOnsetTimeSec: number): void {
    const match = grader.findNearestTarget(rawOnsetTimeSec, true);
    if (!match || Math.abs(match.offsetMs) > 160) {
      return;
    }
    calibrationOffsetsMs.push(match.offsetMs);
    dom.calibrationStatus.textContent = `Pluck right on every click… (${calibrationOffsetsMs.length} / 8)`;
    if (calibrationOffsetsMs.length >= 8) {
      const trimmed = [...calibrationOffsetsMs].sort((a, b) => a - b).slice(1, -1);
      const avgMs = Math.round(trimmed.reduce((a, v) => a + v, 0) / trimmed.length);
      const clampedMs = Math.max(-20, Math.min(85, avgMs));
      setLatency(clampedMs);
      finishCalibration(`Calibrated: latency compensation set to ${clampedMs} ms.`);
    }
  }

  function startLoopbackPing(): void {
    isCalibrating = false;
    isLoopbackPinging = true;
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
    dom.calibrationStatus.textContent =
      'Measuring 6 pings… patch Line Out → Input, or hold the pickup near the speaker.';
    engine.startLoopbackPingTest();
  }

  function handleLoopbackComplete(summary: LoopbackSummary): void {
    if (!isLoopbackPinging) {
      return;
    }
    isLoopbackPinging = false;
    if (!summary.success || summary.medianRtlMs === null) {
      dom.calibrationStatus.textContent =
        'No return pings detected. Turn up output/gain or lower the sensitivity threshold.';
      return;
    }
    const clampedMs = Math.max(-20, Math.min(85, Math.round(summary.medianRtlMs)));
    setLatency(clampedMs);
    dom.calibrationStatus.textContent = `Round-trip latency ${clampedMs} ms (${summary.detectedCount}/${summary.totalPulses} pings) — applied.`;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function syncBassLineButton(): void {
    const on = profile.bassGuideMode !== 'off';
    dom.bassLineBtn.setAttribute('aria-pressed', String(on));
    const labels: Record<BassGuideMode, string> = {
      off: 'Bass line: Off',
      always: 'Bass line: Along',
      'demo-first': 'Bass line: Demo first',
      'call-response-1-1': 'Bass line: Echo 1:1',
      'call-response-1-3': 'Bass line: Echo 1:3',
    };
    dom.bassLineBtn.textContent = labels[profile.bassGuideMode];
  }

  dom.playBtn.addEventListener('click', togglePlay);
  dom.bpmDown.addEventListener('click', () => setBpm(profile.bpm - 1));
  dom.bpmUp.addEventListener('click', () => setBpm(profile.bpm + 1));
  dom.tapBtn.addEventListener('click', handleTap);
  dom.exerciseChip.addEventListener('click', () => drawers.toggle(dom.exerciseDrawer, dom.exerciseChip));
  dom.setupChip.addEventListener('click', () => drawers.toggle(dom.setupDrawer, dom.setupChip));
  dom.resNext.addEventListener('click', () => void startPlaying());
  dom.resStay.addEventListener('click', stayAfterRound);

  dom.bassLineBtn.addEventListener('click', () => {
    const value: BassGuideMode = profile.bassGuideMode === 'off' ? 'always' : 'off';
    segmented.get('bassGuideMode')?.set(value);
    onSettingChanged('bassGuideMode', value);
  });

  dom.groovePatternSelect.addEventListener('change', () => {
    profile.groovePattern = dom.groovePatternSelect.value as GroovePatternId;
    grader.clearTimeline();
    engine.setTransportConfig({ groovePattern: profile.groovePattern });
    rebuildLane();
    persist();
    updateExerciseSummary();
  });

  dom.drillModeSelect.addEventListener('change', () => {
    profile.drillMode = dom.drillModeSelect.value as DrillMode;
    engine.setTransportConfig({ drillMode: profile.drillMode });
    updateTargetDisplay(engine.getCurrentBarNumber());
    persist();
    updateExerciseSummary();
  });

  dom.connectAudioBtn.addEventListener('click', () => {
    void connectAudioInterface(dom.deviceSelect.value || profile.selectedDeviceId);
  });
  dom.deviceSelect.addEventListener('change', () => {
    profile.selectedDeviceId = dom.deviceSelect.value;
    persist();
    void connectAudioInterface(dom.deviceSelect.value);
  });
  dom.outputDeviceSelect.addEventListener('change', () => {
    profile.selectedOutputDeviceId = dom.outputDeviceSelect.value;
    persist();
    void applyOutputSinkSelection(dom.outputDeviceSelect.value, true);
  });
  dom.channelSelect.addEventListener('change', () => {
    profile.selectedChannel = dom.channelSelect.value as InputChannelMode;
    persist();
    engine.setDspConfig({ channelMode: profile.selectedChannel });
  });
  dom.thresholdSlider.addEventListener('input', () => {
    profile.onsetThreshold = parseFloat(dom.thresholdSlider.value);
    persist();
    updateThresholdMarkers();
    engine.setDspConfig({ onsetThreshold: profile.onsetThreshold });
  });
  dom.latencySlider.addEventListener('input', () => {
    setLatency(parseInt(dom.latencySlider.value, 10));
  });
  dom.loopbackPingBtn.addEventListener('click', startLoopbackPing);
  dom.calibrateBtn.addEventListener('click', startTapCalibration);

  function isTypingTarget(el: HTMLElement | null): boolean {
    const tag = el?.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  }

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (e.key === 'Escape') {
      if (drawers.isOpen()) {
        drawers.close();
      } else if (!dom.results.hidden) {
        stayAfterRound();
      }
      return;
    }
    if (isTypingTarget(target) || drawers.isOpen()) {
      return;
    }
    const onButton = target?.tagName === 'BUTTON';
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        if (e.repeat) return;
        if (!dom.results.hidden) {
          void startPlaying();
        } else {
          togglePlay();
        }
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (!onButton && !dom.results.hidden) {
          e.preventDefault();
          void startPlaying();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        setBpm(profile.bpm + (e.shiftKey ? 5 : 1));
        break;
      case 'ArrowDown':
        e.preventDefault();
        setBpm(profile.bpm - (e.shiftKey ? 5 : 1));
        break;
      case 'KeyT':
        handleTap();
        break;
      case 'KeyR':
        resetSession();
        break;
      case 'KeyE':
        e.preventDefault();
        drawers.open(dom.exerciseDrawer, dom.exerciseChip);
        break;
      case 'KeyS':
        e.preventDefault();
        drawers.open(dom.setupDrawer, dom.setupChip);
        break;
    }
  });

  // Space on a focused button would otherwise also "click" it on keyup.
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (e.code === 'Space' && target?.tagName === 'BUTTON' && !drawers.isOpen()) {
      e.preventDefault();
    }
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      void engine
        .enumerateAndResolveDevices(profile.selectedDeviceId, profile.selectedOutputDeviceId)
        .then((lists) => {
          populateDeviceDropdowns(
            lists.inputs,
            lists.outputs,
            profile.selectedDeviceId,
            profile.selectedOutputDeviceId,
          );
        });
    });
  }

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  dom.bpmValue.textContent = String(profile.bpm);
  dom.groovePatternSelect.value = profile.groovePattern;
  dom.drillModeSelect.value = profile.drillMode;
  dom.channelSelect.value = profile.selectedChannel;
  dom.thresholdSlider.value = String(profile.onsetThreshold);
  setLatency(profile.latencyCompensationMs);
  updateThresholdMarkers();
  syncSegmentedFromProfile();
  syncBassLineButton();

  engine.setDspConfig({
    channelMode: profile.selectedChannel,
    onsetThreshold: profile.onsetThreshold,
    instrumentRange: profile.instrumentRange,
  });
  engine.setTransportConfig({
    bpm: profile.bpm,
    subdivision: profile.subdivision,
    groovePattern: profile.groovePattern,
    soundMode: profile.soundMode,
    bassGuideMode: profile.bassGuideMode,
    clickPlacement: profile.clickPlacement,
    pocketCenterMs: profile.pocketCenterMs,
    gapBars: profile.gapBars,
    drillMode: profile.drillMode,
    roundBars: effectiveRoundBars(),
    countInBars: 1,
  });

  rebuildLane();
  lane.setGuide(profile.visualGuide);
  applyPocketSettings();
  updateTargetDisplay(0);
  updateExerciseSummary();
  updateBassGuideHelp();
  setBarCounterIdle();
  setPhaseTag('ready');
  renderGrooveMeter();
  renderSessionStats();
  if (isDemo) {
    dom.audioStatusText.textContent = 'Demo mode';
    dom.audioLed.className = 'led-dot warn';
    showOverlay('Demo — press Space to play', 'Simulated plucks, no instrument needed.');
  }
  lane.start();
}

bootstrapGrooveLock();
