import './style.css';
import {
  AudioEngine,
  type BarScheduleInfo,
  type RecordedPcmChunk,
  type ScheduledSound,
} from './audio/audio-engine';
import { DIAGNOSTICS_MAX_SEC, DiagnosticsRecorder } from './audio/diagnostics';
import {
  assembleTrack,
  mixTakeToWav,
  normalizePeak,
  type PlaybackMode,
  renderSoundsOffline,
  type Take,
  type TakeTick,
  TakePlayer,
  toAudioBuffer,
} from './audio/take';
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
  rhythmForPattern,
  type SoundEngineMode,
  type SpeedTrainerStep,
} from './groove/patterns';
import { type Rhythm, resolveRhythmBarSteps } from './groove/rhythm';
import {
  advanceStaircase,
  buildDrillPlan,
  type DrillId,
  type DrillPlan,
  type DrillRecommendation,
  type DrillSettings,
  type DrillVerdict,
  type FocusMeasurement,
  judgeDrillRound,
  judgeNoteLengthRound,
  measureFocus,
  recommendDrill,
  type StaircaseEvent,
  type StaircaseState,
  startStaircase,
} from './groove/drills';
import {
  appendRound,
  type CoachProgress,
  entryLevelFor,
  isMastered,
  loadCoachProgress,
  loadHistory,
  masteredDrills,
  type RoundRecord,
  saveCoachProgress,
  saveHistory,
  summarizeDays,
  updateDrillProgress,
} from './groove/history';
import { nextUp, type StageState, stageState, TIME_PATH } from './groove/path';
import {
  describeReleases,
  gradeRelease,
  type ReleaseHit,
  releaseWindowMs,
  summarizeReleases,
} from './groove/release-grading';
import type { ReleaseEvent } from './dsp/release';
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
import {
  CALIBRATION_BPM,
  CALIBRATION_MAX_TAP_OFFSET_MS,
  CALIBRATION_TAPS,
  clampLatencyMs,
  detectLatencyIssue,
  estimateLatencyMs,
} from './groove/calibration';
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
import { type LanePhase, TimelineLane } from './ui/timeline-lane';

const MIN_BPM = 40;
const MAX_BPM = 200;
const AUTO_CONTINUE_SEC = 6;
const SESSION_HISTORY_LIMIT = 400;

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
  const parts = [p.customRhythm ? 'Custom rhythm' : patterns[p.groovePattern]];
  if (p.soundMode === 'drums') parts.push('Drums');
  const clicks: Record<ClickPlacementMode, string | null> = {
    all: null,
    beats: 'Click on beats',
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
    resLengths: requireEl<HTMLParagraphElement>('res-lengths'),
    resTempo: requireEl<HTMLParagraphElement>('res-tempo'),
    resNext: requireEl<HTMLButtonElement>('res-next'),
    resStay: requireEl<HTMLButtonElement>('res-stay'),
    resFix: requireEl<HTMLButtonElement>('res-fix'),
    resNextLabel: requireEl<HTMLSpanElement>('res-next-label'),
    resultsTitle: requireEl<HTMLHeadingElement>('results-title'),
    coachBox: requireEl<HTMLDivElement>('coach-box'),
    coachLabel: requireEl<HTMLSpanElement>('coach-label'),
    coachPips: requireEl<HTMLSpanElement>('coach-pips'),
    coachText: requireEl<HTMLParagraphElement>('coach-text'),
    coachCompare: requireEl<HTMLParagraphElement>('coach-compare'),
    drillStrip: requireEl<HTMLDivElement>('drill-strip'),
    drillTitle: requireEl<HTMLSpanElement>('drill-title'),
    drillGoal: requireEl<HTMLSpanElement>('drill-goal'),
    drillPips: requireEl<HTMLSpanElement>('drill-pips'),
    drillLevel: requireEl<HTMLSpanElement>('drill-level'),
    drillExit: requireEl<HTMLButtonElement>('drill-exit'),
    takePlay: requireEl<HTMLButtonElement>('take-play'),
    takeMarks: requireEl<HTMLDivElement>('take-marks'),
    takeHead: requireEl<HTMLDivElement>('take-head'),
    takeMode: requireEl<HTMLDivElement>('take-mode'),
    takeDownload: requireEl<HTMLButtonElement>('take-download'),
    takeStatus: requireEl<HTMLParagraphElement>('take-status'),
    progressChip: requireEl<HTMLButtonElement>('progress-chip'),
    progressDrawer: requireEl<HTMLElement>('progress-drawer'),
    progressDays: requireEl<HTMLDivElement>('progress-days'),
    pathStages: requireEl<HTMLDivElement>('path-stages'),
    pathNext: requireEl<HTMLDivElement>('path-next'),
    pathNextTitle: requireEl<HTMLSpanElement>('path-next-title'),
    pathNextGoal: requireEl<HTMLSpanElement>('path-next-goal'),
    pathNextStart: requireEl<HTMLButtonElement>('path-next-start'),
    progressReset: requireEl<HTMLButtonElement>('progress-reset'),
    diagToggle: requireEl<HTMLButtonElement>('diag-toggle'),
    clockStatus: requireEl<HTMLParagraphElement>('clock-status'),
    diagStatus: requireEl<HTMLParagraphElement>('diag-status'),
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

  /** Steps of each bar of the active phrase, as shown in the lane. */
  let lanePhrase: readonly (readonly PatternStepDescriptor[])[] = [[]];
  /** Steps of one bar; every bar of a phrase shares the same step grid. */
  let laneSteps: readonly PatternStepDescriptor[] = [];
  let currentBarExpectedNote: TargetNoteEvent['expectedNote'] =
    computeBarTarget(profile.drillMode, 0).targetNote;
  let sessionOffsetsMs: number[] = [];

  let isRoundActive = false;
  let roundHits: RoundHit[] = [];
  let roundExpectedTargets = 0;
  /** Graded note lengths of the current round. */
  let roundReleases: ReleaseHit[] = [];
  /** Recently graded notes awaiting their release, and releases that arrived before their note. */
  interface GradedNote {
    readonly onsetSec: number;
    readonly target: TargetNoteEvent;
    readonly stepIndex: number;
    readonly lengthBeats: number;
    readonly stepKey: string;
    readonly stepName: string;
  }
  let gradedNotes: GradedNote[] = [];
  let earlyReleases: ReleaseEvent[] = [];
  let lastSummary: RoundSummary | null = null;
  let countdownTimerId: number | null = null;
  let tapTimesMs: number[] = [];

  /** A drill in progress; practice settings are swapped for the drill's and restored on exit. */
  interface ActiveDrill {
    readonly plan: DrillPlan;
    staircase: StaircaseState;
    readonly savedSettings: DrillSettings;
    /** The round before the drill (Fix it), or `null` when started from the Time Path. */
    readonly baselineSummary: RoundSummary | null;
    readonly baselineFocus: FocusMeasurement | null;
    isComplete: boolean;
  }
  let activeDrill: ActiveDrill | null = null;
  let pendingRecommendation: {
    readonly rec: DrillRecommendation;
    readonly summary: RoundSummary;
    readonly hits: readonly RoundHit[];
    readonly releases: readonly ReleaseHit[];
  } | null = null;
  // Coach memory
  let roundHistory: RoundRecord[] = loadHistory(window.localStorage);
  let coachProgress: CoachProgress = loadCoachProgress(window.localStorage);
  const EVIDENCE_ROUNDS = 3;
  /** Recent rounds of the same groove, pooled so the Coach diagnoses from more than one round. */
  let evidence: { key: string; rounds: { hits: RoundHit[]; expected: number }[] } | null = null;

  /** Set when returning to the groove after a drill, so the next round compares against before. */
  let transferBaseline: { readonly title: string; readonly summary: RoundSummary } | null = null;

  // Round recording & playback
  const MAX_TAKES = 5;
  const TAKE_PRE_ROLL_BEATS = 1;
  const TAKE_TAIL_SEC = 1.2;
  /** Everything captured for one round; a new round never writes into an older session. */
  interface RoundRecording {
    readonly chunks: RecordedPcmChunk[];
    readonly demoBass: ScheduledSound[];
    readonly ticks: { timeSec: number; judgment: HitJudgment }[];
    readonly barStartsSec: number[];
    endSec: number;
  }
  /** The session collecting bars, ticks and sounds for the round in progress. */
  let recording: RoundRecording | null = null;
  /** The session receiving PCM; stays on a finished round until its final chunk has arrived. */
  let pcmSink: RoundRecording | null = null;
  let takes: Take[] = [];
  let currentTake: Take | null = null;
  let currentTakeBarsSec: number[] = [];
  let playbackMode: PlaybackMode = 'mix';
  /** Incremented whenever the results card is invalidated, so stale take builds are dropped. */
  let resultsToken = 0;
  /** `true` while the results card waits for playback to end before starting the countdown. */
  let countdownAfterPlayback = false;
  let takeAnimationId: number | null = null;

  /** Active diagnostic recording, if any. */
  let diagnostics: DiagnosticsRecorder | null = null;
  let diagnosticsTimerId: number | null = null;

  let isCalibrating = false;
  let calibrationOffsetsMs: number[] = [];
  /** The player's settings while tap calibration temporarily runs its own slow click. */
  let calibrationSavedSettings: DrillSettings | null = null;
  /** What the results card's coach button does. */
  let resultsFixAction: 'drill' | 'calibrate' = 'drill';
  let isLoopbackPinging = false;

  const engine = new AudioEngine({
    onMeter: handleMeterSnapshot,
    onPluck: handlePluckEvent,
    onRelease: handleReleaseEvent,
    onTargetScheduled: handleTargetScheduled,
    onBeatLamp: () => {},
    onStepLamp: handleStepLamp,
    onLoopbackComplete: handleLoopbackComplete,
    onBarScheduled: handleBarScheduled,
    onCountInBeat: handleCountInBeat,
    onRoundComplete: handleRoundComplete,
    onPcmChunk: (chunk) => {
      pcmSink?.chunks.push(chunk);
    },
    onDiagnosticChunk: (chunk) => diagnostics?.addChunk(chunk),
    onSoundScheduled: (sound) => diagnostics?.addSound(sound),
  });

  const lane = new TimelineLane(dom.timelineCanvas, () => engine.getAudioClockSec());
  const takePlayer = new TakePlayer(() => engine.getOutputContext());
  const pocketMeter = new PocketMeter(dom.pocketCanvas);

  const demoPlayer = isDemo
    ? new DemoPlayer({
        deliver: handlePluckEvent,
        readClock: () => engine.getAudioClockSec(),
        hardwareLatencyMs: Number(new URLSearchParams(window.location.search).get('demoLatency') ?? 18),
        readRange: () => profile.instrumentRange,
        deliverRelease: (release) => handleReleaseEvent(release),
        readLengthSec: (target) => {
          if (!activeRhythm().gradeLengths) return null;
          const bar = lanePhrase[((target.barNumber % lanePhrase.length) + lanePhrase.length) % lanePhrase.length];
          const step = bar?.find((st) => st.beatInBar === target.beatInBar && st.subIndex === target.subIndex);
          return step && step.lengthBeats > 0 ? (step.lengthBeats * 60) / profile.bpm : null;
        },
      })
    : null;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /**
   * Saves the profile; during a drill or calibration the player's own practice settings are saved
   * instead of the temporary ones.
   */
  function persist(): void {
    const own = calibrationSavedSettings ?? activeDrill?.savedSettings ?? null;
    saveProfile(own ? { ...profile, ...own } : profile);
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
      case 'playbackAfterRound':
        profile.playbackAfterRound = raw === 'true';
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
      playbackAfterRound: String(profile.playbackAfterRound),
    };
    for (const [setting, value] of Object.entries(values)) {
      segmented.get(setting)?.set(value);
    }
  }

  function updateExerciseSummary(): void {
    const summary = activeDrill
      ? `Drill · ${activeDrill.plan.title} · Level ${activeDrill.staircase.level + 1}/${activeDrill.plan.levels.length}`
      : formatExerciseSummary(profile);
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

  /** The rhythm being practiced: a drill's custom rhythm, else the selected pattern. */
  function activeRhythm(): Rhythm {
    return profile.customRhythm ?? rhythmForPattern(profile.groovePattern, profile.subdivision);
  }

  function phraseNoteLabels(): string[][] {
    return lanePhrase.map((steps) => noteLabelsFor(steps, currentBarExpectedNote));
  }

  function rebuildLane(): void {
    const rhythm = activeRhythm();
    lanePhrase = rhythm.bars.map((_, i) => resolveRhythmBarSteps(rhythm, i));
    laneSteps = lanePhrase[0] ?? [];
    lane.setSteps(lanePhrase, phraseNoteLabels());
    const disabled = profile.groovePattern !== 'uniform' || profile.customRhythm !== null;
    segmented.get('subdivision')?.setDisabled(disabled);
    dom.subdivisionHelp.hidden = !disabled;
  }

  function refreshNoteLabels(): void {
    lane.setNoteLabels(phraseNoteLabels());
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
    if (ms !== profile.latencyCompensationMs) {
      diagnostics?.addNote(`latencyCompensationMs ${profile.latencyCompensationMs} -> ${ms}`);
    }
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

  /** Input samples at or above this are treated as clipping (digital full scale is 1.0). */
  const CLIP_LEVEL = 0.98;
  const CLIP_HOLD_MS = 2500;
  let clippingUntilMs = 0;

  function handleMeterSnapshot(snapshot: MeterSnapshot): void {
    dom.meterCh1.style.width = `${Math.min(100, (snapshot.rmsCh0 / 0.2) * 100).toFixed(1)}%`;
    dom.meterCh2.style.width = `${Math.min(100, (snapshot.rmsCh1 / 0.2) * 100).toFixed(1)}%`;
    const now = performance.now();
    if (snapshot.peak >= CLIP_LEVEL) {
      clippingUntilMs = now + CLIP_HOLD_MS;
    }
    const clipping = now < clippingUntilMs;
    dom.peakDbReadout.textContent = clipping
      ? 'CLIPPING: turn input gain down'
      : snapshot.activeRms > 0.0001
        ? `${(20 * Math.log10(snapshot.activeRms)).toFixed(1)} dB`
        : '−∞ dB';
    dom.peakDbReadout.classList.toggle('is-clipping', clipping);
    dom.setupChip.classList.toggle('is-clipping', clipping);
    dom.setupChip.title = clipping ? 'Input is clipping: turn the Scarlett gain down' : '';
    renderClockStatus();
  }

  /** Drift (ms) of the input delay since calibration that warrants re-measuring. */
  const DRIFT_WARN_MS = 10;

  function renderClockStatus(): void {
    const device = engine.getInputClockDeviceLabel();
    const drift = engine.getInputDriftMs();
    const driftText =
      drift === null ? 'measuring drift…' : `input delay changed ${drift >= 0 ? '+' : ''}${drift.toFixed(0)} ms since calibration`;
    const clockText = device ? `Input clock: locked to ${device}` : 'Input clock: separate from the interface';
    dom.clockStatus.textContent =
      drift !== null && Math.abs(drift) >= DRIFT_WARN_MS
        ? `${clockText} · ${driftText}. Run Loopback ping again.`
        : `${clockText} · ${driftText}`;
    dom.clockStatus.classList.toggle('is-clipping', drift !== null && Math.abs(drift) >= DRIFT_WARN_MS);
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
    stopTakePlayback();
    resultsToken++;
    dom.results.hidden = true;
    if (!isDemo && !engine.isInputConnected()) {
      await connectAudioInterface(dom.deviceSelect.value || profile.selectedDeviceId);
    }
    roundHits = [];
    roundReleases = [];
    roundExpectedTargets = 0;
    isRoundActive = effectiveRoundBars() > 0;
    grader.clearTimeline();
    lane.clearBars();
    beginRoundRecording();
    engine.setTransportConfig({ roundBars: effectiveRoundBars(), countInBars: 1 });
    engine.startMetronome();
    setPlayButton(true);
    hideOverlay();
    setPhaseTag('count-in');
    dom.barCounter.textContent = 'Get ready';
  }

  function stopPlaying(): void {
    engine.stopMetronome();
    if (isCalibrating) {
      endCalibrationMode();
    }
    isRoundActive = false;
    discardRoundRecording();
    stopTakePlayback();
    resultsToken++;
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
      continueAfterResults();
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
    recordRoundHistory(summary);
    const token = ++resultsToken;
    countdownAfterPlayback = recording !== null && profile.playbackAfterRound;
    void finishRoundRecording(token);

    if (activeDrill) {
      completeDrillRound(activeDrill, summary);
      return;
    }

    const latencyIssue = detectLatencyIssue(summary);
    const pooled = addEvidence(roundHits, roundExpectedTargets);
    const pooledSummary = summarizeRound(pooled.hits, {
      pocketWindowMs: profile.pocketWindowMs,
      expectedTargetCount: pooled.expected,
    });
    const rec = recommendDrill(pooledSummary, pooled.hits, {
      pocketWindowMs: profile.pocketWindowMs,
      expectedTargetCount: pooled.expected,
      mastered: masteredDrills(coachProgress),
      releases: roundReleases.length > 0 ? summarizeReleases(roundReleases) : undefined,
    });
    pendingRecommendation =
      rec && !latencyIssue
        ? { rec, summary: pooledSummary, hits: pooled.hits, releases: [...roundReleases] }
        : null;

    let compare: string | null = null;
    if (transferBaseline) {
      const before = transferBaseline.summary;
      compare = `Before ${transferBaseline.title}: ${before.inPocketPct}% in pocket → now ${summary.inPocketPct}%`;
      transferBaseline = null;
    }

    let tempoMessage: string | null = null;
    if (summary.stars === 3 && profile.speedTrainerStep > 0 && profile.bpm < MAX_BPM) {
      setBpm(profile.bpm + profile.speedTrainerStep);
      tempoMessage = `Tempo up → ${profile.bpm} BPM next round`;
    }

    dom.resultsTitle.textContent = compare ? 'Back in the groove' : 'Round complete';
    dom.resFix.hidden = rec === null && latencyIssue === null;
    dom.resNextLabel.textContent = 'Next round';
    resultsFixAction = latencyIssue ? 'calibrate' : 'drill';
    if (latencyIssue) {
      dom.resFix.replaceChildren('Calibrate now ', kbd('C'));
      showCoachBox('Check your latency first', latencyIssue.message, compare, null);
    } else if (rec) {
      const plan = buildDrillPlan(rec.drillId, currentDrillSettings(), rec.focusStep);
      const entry = entryLevelFor(coachProgress, rec.drillId, plan.levels.length);
      const evidenceNote =
        pooled.rounds > 1 ? ` · from your last ${pooled.rounds} rounds (${pooled.hits.length} notes)` : '';
      const memoryNote =
        entry > 0
          ? ` You reached level ${(coachProgress[rec.drillId]?.bestLevel ?? 0) + 1} last time, so you'll start at level ${entry + 1}.`
          : '';
      dom.resFix.replaceChildren(`Fix it: ${plan.title} `, kbd('F'));
      showCoachBox(`Coach suggests: ${plan.title}${evidenceNote}`, rec.reason + memoryNote, compare, null);
    } else if (compare) {
      showCoachBox('Coach', 'Nice work in the drill.', compare, null);
    } else {
      dom.coachBox.hidden = true;
    }
    dom.resTip.hidden = !dom.coachBox.hidden;
    showResults(summary, tempoMessage);
  }

  function kbd(text: string): HTMLElement {
    const el = document.createElement('kbd');
    el.textContent = text;
    return el;
  }

  function showCoachBox(
    label: string,
    text: string,
    compare: string | null,
    drill: ActiveDrill | null,
  ): void {
    dom.coachLabel.textContent = label;
    dom.coachText.textContent = text;
    dom.coachCompare.hidden = compare === null;
    dom.coachCompare.textContent = compare ?? '';
    renderPips(dom.coachPips, drill);
    dom.coachBox.hidden = false;
  }

  function resetTakeUi(): void {
    stopTakePlayback();
    currentTake = null;
    dom.takeMarks.replaceChildren();
    dom.takeDownload.disabled = true;
    dom.takeStatus.textContent = countdownAfterPlayback || profile.playbackAfterRound ? 'Preparing playback…' : '';
  }

  function showResults(summary: RoundSummary, tempoMessage: string | null): void {
    resetTakeUi();
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
    const lengths = describeReleases(summarizeReleases(roundReleases));
    dom.resLengths.hidden = lengths === null;
    dom.resLengths.textContent = lengths ?? '';
    dom.resTempo.hidden = tempoMessage === null;
    dom.resTempo.textContent = tempoMessage ?? '';
    dom.results.hidden = false;

    dom.countdown.hidden = !profile.autoContinue;
    if (profile.autoContinue) {
      if (countdownAfterPlayback) {
        cancelCountdown();
        dom.countdownFill.style.transform = 'scaleX(1)';
        dom.countdownText.textContent = 'Next round after playback';
      } else {
        startCountdown();
      }
    }
  }

  function startCountdown(): void {
    cancelCountdown();
    const startMs = performance.now();
    const tick = (): void => {
      const elapsedSec = (performance.now() - startMs) / 1000;
      const remaining = Math.max(0, AUTO_CONTINUE_SEC - elapsedSec);
      dom.countdownFill.style.transform = `scaleX(${(remaining / AUTO_CONTINUE_SEC).toFixed(3)})`;
      dom.countdownText.textContent = activeDrill?.isComplete
        ? `Back to your groove in ${Math.ceil(remaining)} s`
        : `Next round in ${Math.ceil(remaining)} s`;
      if (remaining <= 0) {
        cancelCountdown();
        continueAfterResults();
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
    stopTakePlayback();
    countdownAfterPlayback = false;
    resultsToken++;
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

  // ---------------------------------------------------------------------------
  // Coach: drills
  // ---------------------------------------------------------------------------

  function currentDrillSettings(): DrillSettings {
    return {
      bpm: profile.bpm,
      groovePattern: profile.groovePattern,
      customRhythm: profile.customRhythm,
      subdivision: profile.subdivision,
      clickPlacement: profile.clickPlacement,
      gapBars: profile.gapBars,
      pocketCenterMs: profile.pocketCenterMs,
      pocketWindowMs: profile.pocketWindowMs,
      soundMode: profile.soundMode,
      bassGuideMode: profile.bassGuideMode,
      roundBars: profile.roundBars,
      drillMode: profile.drillMode,
      speedTrainerStep: profile.speedTrainerStep,
    };
  }

  /** Applies a full set of practice settings to the profile, engine and every control. */
  function applyPracticeSettings(settings: DrillSettings): void {
    Object.assign(profile, settings);
    dom.bpmValue.textContent = String(profile.bpm);
    dom.groovePatternSelect.value = profile.groovePattern;
    dom.drillModeSelect.value = profile.drillMode;
    grader.clearTimeline();
    engine.setTransportConfig({
      bpm: profile.bpm,
      subdivision: profile.subdivision,
      groovePattern: profile.groovePattern,
      customRhythm: profile.customRhythm,
      soundMode: profile.soundMode,
      bassGuideMode: profile.bassGuideMode,
      clickPlacement: profile.clickPlacement,
      pocketCenterMs: profile.pocketCenterMs,
      gapBars: profile.gapBars,
      drillMode: profile.drillMode,
      roundBars: effectiveRoundBars(),
    });
    syncSegmentedFromProfile();
    syncBassLineButton();
    rebuildLane();
    applyPocketSettings();
    updateTargetDisplay(0);
    updateExerciseSummary();
    updateBassGuideHelp();
    setBarCounterIdle();
    persist();
  }

  function renderPips(container: HTMLElement, drill: ActiveDrill | null): void {
    container.replaceChildren();
    if (!drill) return;
    drill.plan.levels.forEach((_, i) => {
      const pip = document.createElement('span');
      pip.className =
        i < drill.staircase.level || (drill.isComplete && i === drill.staircase.level)
          ? 'pip done'
          : i === drill.staircase.level
            ? 'pip current'
            : 'pip';
      container.appendChild(pip);
    });
  }

  function updateDrillStrip(): void {
    const drill = activeDrill;
    dom.drillStrip.hidden = drill === null;
    if (!drill) {
      lane.setFocusStep(null);
      return;
    }
    const level = drill.plan.levels[drill.staircase.level];
    dom.drillTitle.textContent = drill.plan.title;
    dom.drillGoal.textContent = drill.plan.goal;
    dom.drillGoal.title = drill.plan.goal;
    const mastered = isMastered(coachProgress, drill.plan.drillId) ? ' · 🏅 mastered' : '';
    dom.drillLevel.textContent = `Level ${drill.staircase.level + 1}/${drill.plan.levels.length} · ${level.label}${mastered}`;
    renderPips(dom.drillPips, drill);
    const focusKey = drill.plan.focusStep?.key;
    const idx = focusKey
      ? laneSteps.findIndex((s) => stepKeyOf(s.beatInBar, s.subIndex) === focusKey)
      : -1;
    lane.setFocusStep(idx >= 0 ? idx : null);
  }

  function formatFocus(m: FocusMeasurement): string {
    if (m.value === null) return '—';
    if (m.unit === '%') return `${m.value}%`;
    return /spread/i.test(m.label) ? `${m.value.toFixed(1)} ms` : formatSignedMs(m.value);
  }

  /** Starts the Coach's recommended drill from the results card. */
  function startRecommendedDrill(): void {
    const pending = pendingRecommendation;
    if (!pending || activeDrill) return;
    const saved = currentDrillSettings();
    const plan = buildDrillPlan(pending.rec.drillId, saved, pending.rec.focusStep);
    const entry = entryLevelFor(coachProgress, plan.drillId, plan.levels.length);
    activeDrill = {
      plan,
      staircase: startStaircase(entry),
      savedSettings: saved,
      baselineSummary: pending.summary,
      baselineFocus: measureFocus(plan, pending.hits, pending.releases),
      isComplete: false,
    };
    pendingRecommendation = null;
    evidence = null;
    applyPracticeSettings(plan.levels[entry].settings);
    updateDrillStrip();
    void startPlaying();
  }

  /** Starts a drill from the Time Path, at one level below the player's best. */
  function startPathDrill(drillId: DrillId): void {
    if (activeDrill) {
      exitDrill(false);
    } else if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
    cancelCountdown();
    dom.results.hidden = true;
    pendingRecommendation = null;
    const saved = currentDrillSettings();
    const plan = buildDrillPlan(drillId, saved, null);
    const entry = entryLevelFor(coachProgress, plan.drillId, plan.levels.length);
    activeDrill = {
      plan,
      staircase: startStaircase(entry),
      savedSettings: saved,
      baselineSummary: null,
      baselineFocus: null,
      isComplete: false,
    };
    evidence = null;
    drawers.close();
    applyPracticeSettings(plan.levels[entry].settings);
    updateDrillStrip();
    void startPlaying();
  }

  /**
   * Leaves the drill and restores the player's own settings.
   *
   * @param transfer When `true`, the next round is compared against the round before the drill.
   */
  function exitDrill(transfer: boolean): void {
    const drill = activeDrill;
    if (!drill) return;
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
    activeDrill = null;
    transferBaseline =
      transfer && drill.baselineSummary
        ? { title: drill.plan.title, summary: drill.baselineSummary }
        : null;
    applyPracticeSettings(drill.savedSettings);
    updateDrillStrip();
    if (!transfer && !dom.results.hidden) {
      cancelCountdown();
      dom.results.hidden = true;
      showOverlay('Drill ended — press Space to play', 'Your own settings are back.');
    }
  }

  const VERDICT_TITLES: Readonly<Record<DrillVerdict, string>> = {
    pass: 'Passed ✓ One more to level up',
    neutral: 'Almost. Keep going',
    fail: 'Tough one. Try again',
  };

  function completeDrillRound(drill: ActiveDrill, summary: RoundSummary): void {
    const verdict =
      drill.plan.drillId === 'note-length'
        ? judgeNoteLengthRound(summary, summarizeReleases(roundReleases), roundExpectedTargets)
        : judgeDrillRound(summary, roundHits, {
            pocketWindowMs: profile.pocketWindowMs,
            focusStepKey: drill.plan.focusStep?.key ?? null,
          });
    const { state, event } = advanceStaircase(drill.staircase, verdict, drill.plan.levels.length);
    drill.staircase = state;
    drill.isComplete = event === 'complete';
    const wasMastered = isMastered(coachProgress, drill.plan.drillId);
    coachProgress = updateDrillProgress(coachProgress, drill.plan.drillId, {
      levelReached: state.level,
      levelCount: drill.plan.levels.length,
      completed: drill.isComplete,
      now: new Date(),
    });
    saveCoachProgress(coachProgress, window.localStorage);
    const justMastered = !wasMastered && isMastered(coachProgress, drill.plan.drillId);
    if (event === 'level-up' || event === 'level-down') {
      applyPracticeSettings(drill.plan.levels[state.level].settings);
    }
    updateDrillStrip();
    updateExerciseSummary();

    const titles: Record<StaircaseEvent, string> = {
      hold: VERDICT_TITLES[verdict],
      'level-up': `Level up! → Level ${state.level + 1}`,
      'level-down': "Let's step back a level",
      complete: justMastered ? 'Drill mastered! 🏅' : 'Drill complete! 🎉',
    };
    dom.resultsTitle.textContent = titles[event];

    const now = measureFocus(drill.plan, roundHits, roundReleases);
    const compare = drill.baselineFocus
      ? `${now.label}: ${formatFocus(drill.baselineFocus)} → ${formatFocus(now)}`
      : `${now.label}: ${formatFocus(now)}`;
    const nextLevel = drill.plan.levels[state.level];
    const text = drill.isComplete
      ? justMastered
        ? 'You beat every level on two different days. This one is yours now. Play your own groove again and hear the difference.'
        : 'You beat every level. Now play your own groove again and see the difference. Beat it again on another day to master it.'
      : event === 'level-down'
        ? `Back to ${nextLevel.label}. Get comfortable here first.`
        : event === 'level-up'
          ? `Next: ${nextLevel.label}.`
          : `Still on ${nextLevel.label}. ${drill.plan.goal}`;
    showCoachBox(
      `${drill.plan.title} · Level ${state.level + 1}/${drill.plan.levels.length}`,
      text,
      compare,
      drill,
    );
    dom.resTip.hidden = true;
    dom.resFix.hidden = true;
    dom.resNextLabel.textContent = drill.isComplete ? 'Back to your groove' : 'Next round';
    showResults(summary, null);
  }

  /** Adds a normal round to the pooled evidence and returns everything pooled for diagnosis. */
  function addEvidence(
    hits: readonly RoundHit[],
    expected: number,
  ): { hits: RoundHit[]; expected: number; rounds: number } {
    const key = [
      profile.groovePattern,
      JSON.stringify(profile.customRhythm),
      profile.subdivision,
      profile.pocketCenterMs,
      profile.pocketWindowMs,
      profile.clickPlacement,
      profile.gapBars,
      Math.round(profile.bpm / 10),
    ].join('|');
    if (!evidence || evidence.key !== key) {
      evidence = { key, rounds: [] };
    }
    evidence.rounds = [...evidence.rounds, { hits: [...hits], expected }].slice(-EVIDENCE_ROUNDS);
    return {
      hits: evidence.rounds.flatMap((r) => r.hits),
      expected: evidence.rounds.reduce((a, r) => a + r.expected, 0),
      rounds: evidence.rounds.length,
    };
  }

  function recordRoundHistory(summary: RoundSummary): void {
    if (summary.hitCount === 0) return;
    roundHistory = appendRound(roundHistory, {
      at: new Date().toISOString(),
      bpm: profile.bpm,
      groovePattern: profile.groovePattern,
      subdivision: profile.subdivision,
      pocketCenterMs: profile.pocketCenterMs,
      pocketWindowMs: profile.pocketWindowMs,
      drillId: activeDrill?.plan.drillId ?? null,
      drillLevel: activeDrill ? activeDrill.staircase.level : null,
      hitCount: summary.hitCount,
      expectedCount: summary.expectedCount,
      inPocketPct: summary.inPocketPct,
      meanFeelDeltaMs: summary.meanFeelDeltaMs,
      sigmaMs: summary.sigmaMs,
      stars: summary.stars,
    });
    saveHistory(roundHistory, window.localStorage);
  }

  // ---------------------------------------------------------------------------
  // Progress drawer
  // ---------------------------------------------------------------------------

  function relativeDay(day: string, today: string, yesterday: string): string {
    if (day === today) return 'Today';
    if (day === yesterday) return 'Yesterday';
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  const STAGE_BADGES: Readonly<Record<StageState, string>> = {
    soon: 'Coming',
    later: 'Later',
    open: 'Ready',
    started: 'In progress',
    completed: 'Completed',
    mastered: '🏅 Mastered',
  };

  function drillStatus(id: DrillId): string {
    const p = coachProgress[id];
    if (!p) return 'Not tried yet';
    if (isMastered(coachProgress, id)) return '🏅 Mastered';
    if (p.completionDays.length > 0) return 'Done once · again another day';
    return `Best: level ${p.bestLevel + 1}/${p.levelCount}`;
  }

  /** Renders the Time Path: the next drill to do and every stage with its drills. */
  function renderPath(): void {
    const next = nextUp(coachProgress);
    dom.pathNext.hidden = next === null;
    if (next) {
      const plan = buildDrillPlan(next.drillId, currentDrillSettings(), null);
      const stage = TIME_PATH.find((st) => st.id === next.stageId);
      dom.pathNextTitle.textContent = `${stage ? `${stage.title} · ` : ''}${plan.title}`;
      dom.pathNextGoal.textContent = plan.goal;
    }

    dom.pathStages.replaceChildren(
      ...TIME_PATH.map((stage) => {
        const state = stageState(stage, coachProgress);
        const box = document.createElement('div');
        box.className = 'path-stage';
        box.dataset.state = state;

        const head = document.createElement('div');
        head.className = 'path-stage-head';
        const num = document.createElement('span');
        num.className = 'path-stage-number';
        num.textContent = stage.number;
        const title = document.createElement('span');
        title.className = 'path-stage-title';
        title.textContent = stage.title;
        const badge = document.createElement('span');
        badge.className = 'path-stage-badge';
        badge.textContent = STAGE_BADGES[state];
        head.append(num, title, badge);

        const skill = document.createElement('span');
        skill.className = 'path-stage-skill';
        skill.textContent = stage.skill;
        box.append(head, skill);

        for (const item of stage.items) {
          const row = document.createElement('div');
          row.className = 'path-item';
          const name = document.createElement('span');
          name.className = 'path-item-title';
          name.textContent = item.title;
          if (!item.drillId) {
            row.classList.add('is-soon');
            const tag = document.createElement('small');
            tag.textContent = 'coming';
            name.appendChild(tag);
            row.appendChild(name);
            box.appendChild(row);
            continue;
          }
          const id = item.drillId;
          const status = document.createElement('small');
          status.textContent = drillStatus(id);
          name.appendChild(status);
          const pips = document.createElement('span');
          pips.className = 'level-pips';
          const p = coachProgress[id];
          if (p) {
            for (let i = 0; i < p.levelCount; i++) {
              const pip = document.createElement('span');
              pip.className = i <= p.bestLevel ? 'pip done' : 'pip';
              pips.appendChild(pip);
            }
          }
          const play = document.createElement('button');
          play.type = 'button';
          play.className = 'btn';
          play.textContent = 'Play';
          play.addEventListener('click', () => startPathDrill(id));
          if (next?.drillId === id) row.classList.add('is-next');
          row.append(name, pips, play);
          box.appendChild(row);
        }

        const boss = document.createElement('span');
        boss.className = 'path-boss';
        boss.textContent = `Boss groove: ${stage.boss} (coming)`;
        box.appendChild(boss);
        return box;
      }),
    );
  }

  function startNextUp(): void {
    const next = nextUp(coachProgress);
    if (next) startPathDrill(next.drillId);
  }

  function renderProgress(): void {
    const now = new Date();
    const days = summarizeDays(roundHistory, now, 7);
    const today = days[0]?.day ?? '';
    const yesterday = days[1]?.day ?? '';
    dom.progressDays.replaceChildren(
      ...days.map((d) => {
        const row = document.createElement('div');
        row.className = 'progress-row';
        const label = document.createElement('span');
        label.className = 'progress-day';
        label.textContent = relativeDay(d.day, today, yesterday);
        const track = document.createElement('div');
        track.className = 'progress-bar';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        fill.style.width = `${d.avgPocketPct ?? 0}%`;
        track.appendChild(fill);
        const value = document.createElement('span');
        value.className = 'progress-value';
        value.textContent =
          d.rounds === 0
            ? '—'
            : `${d.avgPocketPct}% · ${d.rounds} round${d.rounds === 1 ? '' : 's'}${d.threeStarRounds ? ` · ${d.threeStarRounds}★★★` : ''}`;
        row.append(label, track, value);
        return row;
      }),
    );

    renderPath();
  }

  function resetProgress(): void {
    if (!window.confirm('Reset all round history and drill progress? This cannot be undone.')) return;
    roundHistory = [];
    coachProgress = {};
    evidence = null;
    saveHistory(roundHistory, window.localStorage);
    saveCoachProgress(coachProgress, window.localStorage);
    renderProgress();
  }

  /** What Enter / Space / the countdown do from the results card. */
  function continueAfterResults(): void {
    if (activeDrill?.isComplete) {
      exitDrill(true);
    }
    void startPlaying();
  }

  function handleBarScheduled(info: BarScheduleInfo): void {
    lane.pushBar(info, phaseOf(info));
    if (recording && info.kind === 'play') {
      recording.barStartsSec.push(info.startTimeSec);
      recording.endSec = info.startTimeSec + info.durationSec;
    }
  }

  // ---------------------------------------------------------------------------
  // Round recording & playback
  // ---------------------------------------------------------------------------

  function beginRoundRecording(): void {
    if (effectiveRoundBars() === 0) {
      recording = null;
      return;
    }
    recording = { chunks: [], demoBass: [], ticks: [], barStartsSec: [], endSec: 0 };
    pcmSink = recording;
    engine.beginSoundLog();
    engine.startRecording();
  }

  function discardRoundRecording(): void {
    if (!recording) return;
    recording = null;
    pcmSink = null;
    engine.takeSoundLog();
    void engine.stopRecording();
  }

  /** Builds the take for the round that just ended, then plays it if the results are still up. */
  async function finishRoundRecording(token: number): Promise<void> {
    const rec = recording;
    if (!rec) return;
    recording = null;
    const sounds = engine.takeSoundLog();
    await engine.stopRecording();
    if (pcmSink === rec) pcmSink = null;
    const ctx = engine.getOutputContext();
    const firstBar = rec.barStartsSec[0];
    if (!ctx || firstBar === undefined) {
      onTakeUnavailable(token, 'Nothing to play back.');
      return;
    }
    const beatSec = 60 / profile.bpm;
    const window = {
      startSec: firstBar - TAKE_PRE_ROLL_BEATS * beatSec,
      endSec: rec.endSec + TAKE_TAIL_SEC,
    };
    try {
      const drums = await renderSoundsOffline(sounds, window, ctx.sampleRate);
      let bass: AudioBuffer | null = null;
      if (isDemo) {
        bass = await renderSoundsOffline(rec.demoBass, window, ctx.sampleRate);
      } else {
        const track = assembleTrack(rec.chunks, {
          ...window,
          shiftSec: -profile.latencyCompensationMs / 1000,
        });
        if (track) {
          normalizePeak(track.data, 0.8, 8);
          bass = toAudioBuffer(track.data, track.sampleRate);
        }
      }
      const ticks: TakeTick[] = rec.ticks.map((t) => ({
        timeSec: t.timeSec - window.startSec,
        judgment: t.judgment,
      }));
      const take: Take = { drums, bass, durationSec: window.endSec - window.startSec, ticks };
      takes = [...takes, take].slice(-MAX_TAKES);
      if (token !== resultsToken || dom.results.hidden) return;
      currentTake = take;
      currentTakeBarsSec = rec.barStartsSec.map((t) => t - window.startSec);
      renderTakeTrack();
      dom.takeDownload.disabled = false;
      dom.takeStatus.textContent = bass
        ? 'Your bass and the groove, exactly as graded. L replays.'
        : 'No instrument recorded (connect audio in Setup). Drums only.';
      segmentedTakeMode.setDisabled(bass === null);
      if (profile.playbackAfterRound) {
        playCurrentTake();
      } else {
        countdownAfterPlayback = false;
      }
    } catch {
      onTakeUnavailable(token, 'Playback unavailable for this round.');
    }
  }

  function onTakeUnavailable(token: number, message: string): void {
    if (token !== resultsToken) return;
    dom.takeStatus.textContent = message;
    startCountdownIfWaiting();
  }

  function startCountdownIfWaiting(): void {
    if (countdownAfterPlayback && !dom.results.hidden && profile.autoContinue) {
      countdownAfterPlayback = false;
      startCountdown();
    }
    countdownAfterPlayback = false;
  }

  function renderTakeTrack(): void {
    dom.takeMarks.replaceChildren();
    const take = currentTake;
    if (!take) return;
    const pct = (t: number): string => `${((t / take.durationSec) * 100).toFixed(2)}%`;
    for (const barSec of currentTakeBarsSec) {
      const bar = document.createElement('div');
      bar.className = 'take-bar';
      bar.style.left = pct(barSec);
      dom.takeMarks.appendChild(bar);
    }
    for (const tick of take.ticks) {
      const el = document.createElement('div');
      el.className = 'take-tick';
      el.dataset.judgment = tick.judgment;
      el.style.left = pct(tick.timeSec);
      dom.takeMarks.appendChild(el);
    }
  }

  function playCurrentTake(): void {
    const take = currentTake;
    if (!take) return;
    const started = takePlayer.play(take, playbackMode, () => {
      stopTakeAnimation();
      startCountdownIfWaiting();
    });
    if (!started) {
      startCountdownIfWaiting();
      return;
    }
    dom.takePlay.textContent = '■';
    dom.takePlay.setAttribute('aria-label', 'Stop playback (L)');
    dom.takeHead.classList.add('is-playing');
    const frame = (): void => {
      dom.takeHead.style.left = `${((takePlayer.positionSec() / take.durationSec) * 100).toFixed(2)}%`;
      takeAnimationId = window.requestAnimationFrame(frame);
    };
    stopTakeAnimationFrame();
    takeAnimationId = window.requestAnimationFrame(frame);
  }

  function stopTakeAnimationFrame(): void {
    if (takeAnimationId !== null) {
      window.cancelAnimationFrame(takeAnimationId);
      takeAnimationId = null;
    }
  }

  function stopTakeAnimation(): void {
    stopTakeAnimationFrame();
    dom.takePlay.textContent = '▶';
    dom.takePlay.setAttribute('aria-label', 'Replay (L)');
    dom.takeHead.classList.remove('is-playing');
  }

  function stopTakePlayback(): void {
    takePlayer.stop();
    stopTakeAnimation();
  }

  /** Replay button / L: stop if playing (and let the countdown run), otherwise replay. */
  function toggleTakePlayback(): void {
    if (takePlayer.isPlaying()) {
      stopTakePlayback();
      startCountdownIfWaiting();
      return;
    }
    if (countdownTimerId !== null) {
      cancelCountdown();
      countdownAfterPlayback = profile.autoContinue;
      dom.countdownFill.style.transform = 'scaleX(1)';
      dom.countdownText.textContent = 'Next round after playback';
    }
    playCurrentTake();
  }

  async function downloadCurrentTake(): Promise<void> {
    const take = currentTake;
    if (!take) return;
    const blob = await mixTakeToWav(take);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `groovelock-${stamp}.wav`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function handleCountInBeat(beatInBar: number): void {
    setPhaseTag('count-in', `Count-in · ${beatInBar + 1}`);
  }

  function handleTargetScheduled(event: TargetNoteEvent): void {
    diagnostics?.addTarget(event);
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
    diagnostics?.addPluck(pluck);
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
      trackNoteForRelease(pluck.rawOnsetTimeSec, graded.targetEvent);
      if (isDemo && recording) {
        recording.demoBass.push({
          kind: 'bass',
          timeSec: graded.targetEvent.timeSec + graded.offsetMs / 1000,
          freqHz: pluck.pitch?.freqHz ?? 41.2,
          gateSec: 0.22,
          level: 0.5,
        });
      }
    }
  }

  /** Remembers a graded note so its release can be graded against its written length. */
  function trackNoteForRelease(onsetSec: number, target: TargetNoteEvent): void {
    if (!activeRhythm().gradeLengths) return;
    const bar = lanePhrase[((target.barNumber % lanePhrase.length) + lanePhrase.length) % lanePhrase.length];
    const stepIndex = bar?.findIndex((s) => s.beatInBar === target.beatInBar && s.subIndex === target.subIndex) ?? -1;
    const step = bar?.[stepIndex];
    if (!step || step.lengthBeats <= 0) return;
    const note: GradedNote = {
      onsetSec,
      target,
      stepIndex,
      lengthBeats: step.lengthBeats,
      stepKey: stepKeyOf(target.beatInBar, target.subIndex),
      stepName: formatStepName(target.beatInBar, target.subIndex, engine.getEffectiveSubdivision()),
    };
    const early = earlyReleases.find((r) => Math.abs(r.onsetTimeSec - onsetSec) < 0.003);
    if (early) {
      earlyReleases = earlyReleases.filter((r) => r !== early);
      gradeNoteRelease(note, early);
      return;
    }
    gradedNotes = [...gradedNotes, note].slice(-16);
  }

  function handleReleaseEvent(event: ReleaseEvent): void {
    if (!engine.isMetronomeRunning() || isCalibrating) return;
    const note = gradedNotes.find((n) => Math.abs(n.onsetSec - event.onsetTimeSec) < 0.003);
    if (!note) {
      // The pluck (reported after its pitch settles) may not have arrived yet.
      earlyReleases = [...earlyReleases, event].slice(-8);
      return;
    }
    gradedNotes = gradedNotes.filter((n) => n !== note);
    gradeNoteRelease(note, event);
  }

  function gradeNoteRelease(note: GradedNote, event: ReleaseEvent): void {
    const result = gradeRelease({
      releaseTimeSec: event.releaseTimeSec,
      latencyCompensationMs: profile.latencyCompensationMs,
      targetTimeSec: note.target.timeSec,
      pocketCenterMs: profile.pocketCenterMs,
      lengthBeats: note.lengthBeats,
      bpm: profile.bpm,
      windowMs: releaseWindowMs(profile.pocketWindowMs),
    });
    const secPerBeat = 60 / profile.bpm;
    const heldBeats =
      (event.releaseTimeSec - profile.latencyCompensationMs / 1000 - note.target.timeSec) / secPerBeat;
    lane.recordRelease(note.target.barNumber, note.stepIndex, heldBeats, result.judgment);
    if (isRoundActive) {
      roundReleases.push({
        stepKey: note.stepKey,
        stepName: note.stepName,
        deltaMs: result.deltaMs,
        judgment: result.judgment,
      });
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
    diagnostics?.addGraded({
      targetId: t.id,
      targetTimeSec: t.timeSec,
      offsetMs: entry.offsetMs,
      feelDeltaMs: entry.feelDeltaMs,
      latencyCompensationMs: profile.latencyCompensationMs,
      judgment,
    });
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

    const stepIndex = laneSteps.findIndex(
      (s) => s.beatInBar === t.beatInBar && s.subIndex === t.subIndex,
    );
    if (stepIndex >= 0) {
      lane.recordHit(t.barNumber, stepIndex, entry.feelDeltaMs, judgment);
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
        inSilentBar: t.isSilentGapBar,
      });
      recording?.ticks.push({ timeSec: t.timeSec + entry.offsetMs / 1000, judgment });
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

  /**
   * Tap calibration: plays a plain click at 60 BPM (1 s apart, so even large latencies can't be
   * mistaken for the next beat) and measures how late your plucks arrive. Your own settings are
   * restored afterwards.
   */
  function startTapCalibration(): void {
    isLoopbackPinging = false;
    engine.stopLoopbackPingTest();
    if (activeDrill) {
      exitDrill(false);
    }
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    }
    cancelCountdown();
    stopTakePlayback();
    dom.results.hidden = true;
    const own = currentDrillSettings();
    calibrationSavedSettings = own;
    applyPracticeSettings({
      ...own,
      bpm: CALIBRATION_BPM,
      groovePattern: 'uniform',
      subdivision: 1,
      clickPlacement: 'all',
      gapBars: 0,
      soundMode: 'click',
      bassGuideMode: 'off',
      speedTrainerStep: 0,
    });
    isCalibrating = true;
    calibrationOffsetsMs = [];
    dom.calibrationStatus.textContent = `Pluck right on every click… (0 / ${CALIBRATION_TAPS})`;
    void startPlaying();
  }

  /** Leaves calibration mode and restores the player's own settings. */
  function endCalibrationMode(): void {
    isCalibrating = false;
    const own = calibrationSavedSettings;
    calibrationSavedSettings = null;
    if (own) {
      applyPracticeSettings(own);
    }
  }

  function finishCalibration(message: string): void {
    dom.calibrationStatus.textContent = message;
    if (engine.isMetronomeRunning()) {
      stopPlaying();
    } else if (isCalibrating) {
      endCalibrationMode();
    }
    showOverlay('Calibrated — press Space to play', message);
  }

  function recordCalibrationHit(rawOnsetTimeSec: number): void {
    const match = grader.findNearestTarget(rawOnsetTimeSec, true);
    if (!match || Math.abs(match.offsetMs) > CALIBRATION_MAX_TAP_OFFSET_MS) {
      return;
    }
    calibrationOffsetsMs.push(match.offsetMs);
    dom.calibrationStatus.textContent = `Pluck right on every click… (${calibrationOffsetsMs.length} / ${CALIBRATION_TAPS})`;
    if (calibrationOffsetsMs.length >= CALIBRATION_TAPS) {
      const latencyMs = estimateLatencyMs(calibrationOffsetsMs) ?? profile.latencyCompensationMs;
      setLatency(latencyMs);
      onLatencyCalibrated();
      finishCalibration(`Latency compensation set to ${latencyMs} ms.`);
    }
  }

  /**
   * Timing measured with a different latency compensation isn't comparable: drop the Coach's pooled
   * evidence and the live session stats so nothing mixes before/after calibration.
   */
  function onLatencyCalibrated(): void {
    engine.resetDriftBaseline();
    evidence = null;
    resetSession();
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  async function startDiagnostics(): Promise<void> {
    if (diagnostics) return;
    if (!engine.isInputConnected()) {
      const ok = await connectAudioInterface(dom.deviceSelect.value || profile.selectedDeviceId);
      if (!ok) {
        dom.diagStatus.textContent = 'Connect your audio input first.';
        return;
      }
    }
    const rec = new DiagnosticsRecorder();
    rec.addNote(`start; latencyCompensationMs=${profile.latencyCompensationMs}`);
    rec.addSnapshot(engine.getClockSnapshot());
    diagnostics = rec;
    engine.startDiagnosticRecording();
    dom.diagToggle.textContent = 'Stop & download';
    dom.diagToggle.classList.add('btn-coach');
    diagnosticsTimerId = window.setInterval(() => {
      if (!diagnostics) return;
      diagnostics.addSnapshot(engine.getClockSnapshot());
      const sec = Math.floor(diagnostics.durationSec());
      dom.diagStatus.textContent = `Recording ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · ${diagnostics.pluckCount()} plucks detected`;
      if (sec >= DIAGNOSTICS_MAX_SEC) {
        void stopDiagnostics();
      }
    }, 500);
  }

  async function stopDiagnostics(): Promise<void> {
    const rec = diagnostics;
    if (!rec) return;
    if (diagnosticsTimerId !== null) {
      window.clearInterval(diagnosticsTimerId);
      diagnosticsTimerId = null;
    }
    await engine.stopDiagnosticRecording();
    rec.addSnapshot(engine.getClockSnapshot());
    rec.addNote('stop');
    diagnostics = null;
    dom.diagToggle.textContent = 'Start diagnostic recording';
    dom.diagToggle.classList.remove('btn-coach');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = `groovelock-diag-${stamp}`;
    const { wav, json } = rec.export(
      {
        profile: { ...profile },
        inputTrack: engine.getInputTrackInfo(),
        inputDeviceLabel: dom.deviceSelect.selectedOptions[0]?.textContent ?? '',
        outputDeviceLabel: dom.outputDeviceSelect.selectedOptions[0]?.textContent ?? '',
        outputSinkStatus: dom.outputSinkStatus.textContent,
        inputClockDevice: engine.getInputClockDeviceLabel(),
        inputDriftMs: engine.getInputDriftMs(),
      },
      `${base}.wav`,
    );
    downloadBlob(json, `${base}.json`);
    if (wav) {
      window.setTimeout(() => downloadBlob(wav, `${base}.wav`), 400);
    }
    dom.diagStatus.textContent = `Saved ${base}.json${wav ? ' and .wav' : ''} to your Downloads folder.`;
  }

  function downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /** Results card "Calibrate now": open Setup and start tap calibration. */
  function calibrateFromResults(): void {
    drawers.open(dom.setupDrawer, dom.setupChip);
    startTapCalibration();
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
    diagnostics?.addLoopback(summary);
    if (!isLoopbackPinging) {
      return;
    }
    isLoopbackPinging = false;
    if (!summary.success || summary.medianRtlMs === null) {
      dom.calibrationStatus.textContent =
        'No return pings detected. Turn up output/gain or lower the sensitivity threshold.';
      return;
    }
    const clampedMs = clampLatencyMs(summary.medianRtlMs);
    setLatency(clampedMs);
    onLatencyCalibrated();
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
  dom.progressChip.addEventListener('click', () => {
    renderProgress();
    drawers.toggle(dom.progressDrawer, dom.progressChip);
  });
  dom.progressReset.addEventListener('click', resetProgress);
  dom.pathNextStart.addEventListener('click', startNextUp);
  dom.diagToggle.addEventListener('click', () => {
    void (diagnostics ? stopDiagnostics() : startDiagnostics());
  });
  dom.resNext.addEventListener('click', continueAfterResults);
  dom.resFix.addEventListener('click', () => {
    if (resultsFixAction === 'calibrate') {
      calibrateFromResults();
    } else {
      startRecommendedDrill();
    }
  });
  dom.drillExit.addEventListener('click', () => exitDrill(false));
  dom.takePlay.addEventListener('click', toggleTakePlayback);
  dom.takeDownload.addEventListener('click', () => void downloadCurrentTake());
  const segmentedTakeMode = bindSegmented(dom.takeMode, (value) => {
    playbackMode = value as PlaybackMode;
    takePlayer.setMode(playbackMode);
  });
  segmentedTakeMode.set(playbackMode);
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
  dom.latencySlider.addEventListener('change', onLatencyCalibrated);
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
    if (
      e.code === 'KeyN' &&
      !isTypingTarget(target) &&
      !e.repeat &&
      dom.results.hidden &&
      !engine.isMetronomeRunning()
    ) {
      // Next up on the Time Path, from the Play view or from inside the Path drawer.
      if (!drawers.isOpen() || dom.progressDrawer.classList.contains('is-open')) {
        e.preventDefault();
        startNextUp();
        return;
      }
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
          continueAfterResults();
        } else {
          togglePlay();
        }
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (!onButton && !dom.results.hidden) {
          e.preventDefault();
          continueAfterResults();
        }
        break;
      case 'KeyF':
        if (!dom.results.hidden && pendingRecommendation && !activeDrill) {
          e.preventDefault();
          startRecommendedDrill();
        }
        break;
      case 'KeyC':
        if (!dom.results.hidden && resultsFixAction === 'calibrate' && !dom.resFix.hidden) {
          e.preventDefault();
          calibrateFromResults();
        }
        break;
      case 'KeyL':
        if (!dom.results.hidden && currentTake) {
          e.preventDefault();
          toggleTakePlayback();
        }
        break;
      case 'KeyX':
        if (activeDrill) {
          e.preventDefault();
          exitDrill(false);
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
      case 'KeyP':
        e.preventDefault();
        renderProgress();
        drawers.open(dom.progressDrawer, dom.progressChip);
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
    customRhythm: profile.customRhythm,
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
