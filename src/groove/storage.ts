import type { InputChannelMode, InstrumentRange } from '../dsp/types';
import type {
  BassGuideMode,
  ClickPlacementMode,
  GroovePatternId,
  PocketFeelOffsetMs,
  SoundEngineMode,
  SpeedTrainerStep,
} from './patterns';
import type { DrillMode, GapClickMode, Subdivision } from './timeline';

/**
 * Serializable user hardware & practice configuration persisted in `localStorage`.
 */
export interface GrooveLockProfile {
  /** Preferred `MediaDeviceInfo.deviceId` for instrument capture (e.g. Scarlett Solo). */
  selectedDeviceId: string;
  /** Preferred `MediaDeviceInfo.deviceId` for click playback (e.g. Scarlett or Fosi DAC). */
  selectedOutputDeviceId: string;
  /** Hardware input channel selection (`'auto'`, `'0'`, `'1'`, or `'sum'`). */
  selectedChannel: InputChannelMode;
  /** RMS threshold (`0.008..0.180`) required to trigger a pluck onset. */
  onsetThreshold: number;
  /** Calibrated hardware round-trip latency compensation in milliseconds (`-20..85`). */
  latencyCompensationMs: number;
  /** Metronome tempo in beats per minute (`40..200`). */
  bpm: number;
  /** Subdivision grid steps per quarter-note beat (`1..4`) when `groovePattern === 'uniform'`. */
  subdivision: Subdivision;
  /** Active rhythmic groove pattern template (`'uniform'`, `'motown-pocket'`, `'funk-16th'`, etc.). */
  groovePattern: GroovePatternId;
  /** Audible reference sound engine (`'click'` or `'drums'`). */
  soundMode: SoundEngineMode;
  /** Reference bass playback mode (`'off'`, `'call-response-1-1'`, `'call-response-1-3'`, `'demo-first'`, `'always'`). */
  bassGuideMode: BassGuideMode;
  /** Beat placement mode for clicks/drums (`'all'`, `'backbeat-2-4'`, `'one-drop-1'`, `'offbeat-and'`). */
  clickPlacement: ClickPlacementMode;
  /** In-the-pocket tolerance half-window in milliseconds (`10`, `16`, or `25`). */
  pocketWindowMs: number;
  /** Intentional micro-timing feel center in milliseconds (`0`, `12`, or `-8`). */
  pocketCenterMs: PocketFeelOffsetMs;
  /** Gap-click silent bar trainer mode (`0`, `1`, or `2`). */
  gapBars: GapClickMode;
  /** Auto-tempo Speed Trainer increment (`0`, `2`, or `4` BPM per 4 clean bars). */
  speedTrainerStep: SpeedTrainerStep;
  /** Active target note exercise (`'free'`, `'root-cycle'`, `'random-bar'`, `'fixed-e'`, `'fixed-a'`). */
  drillMode: DrillMode;
  /** Instrument pitch filter (`'bass'`, `'guitar'`, or `'full'`). */
  instrumentRange: InstrumentRange;
  /** Graded bars per practice round (`4`, `8`, `16`), or `0` for continuous play. */
  roundBars: RoundLengthBars;
  /** When `true`, the next round starts automatically after the results card countdown. */
  autoContinue: boolean;
  /** Visual timing help on the timeline lane (`'none'`, `'glow'`, or `'sweep'`). */
  visualGuide: VisualGuideMode;
}

/**
 * How much visual timing help the timeline lane gives while playing:
 * - `'none'`: no position indicator (ears only).
 * - `'glow'`: the current beat column lights up as it sounds (orientation, can't be anticipated).
 * - `'sweep'`: a continuously moving playhead (predictive; pulls attention to the eyes).
 */
export type VisualGuideMode = 'none' | 'glow' | 'sweep';

/** Bars per practice round; `0` means continuous (no rounds). */
export type RoundLengthBars = 0 | 4 | 8 | 16;

const STORAGE_KEY = 'groovelock.profile.v1';

/**
 * Default studio settings used on first launch or if `localStorage` is unavailable.
 */
export const DEFAULT_PROFILE: GrooveLockProfile = {
  selectedDeviceId: '',
  selectedOutputDeviceId: '',
  selectedChannel: 'auto',
  onsetThreshold: 0.035,
  latencyCompensationMs: 18,
  bpm: 90,
  subdivision: 1,
  groovePattern: 'uniform',
  soundMode: 'click',
  bassGuideMode: 'off',
  clickPlacement: 'all',
  pocketWindowMs: 16,
  pocketCenterMs: 0,
  gapBars: 0,
  speedTrainerStep: 0,
  drillMode: 'free',
  instrumentRange: 'bass',
  roundBars: 8,
  autoContinue: true,
  visualGuide: 'glow',
};

/**
 * Loads and schema-validates the user's `GrooveLockProfile` from `localStorage`.
 * Any missing or out-of-range fields fall back safely to `DEFAULT_PROFILE`.
 */
export function loadProfile(): GrooveLockProfile {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PROFILE };
    }
    const parsed = JSON.parse(raw) as Partial<GrooveLockProfile>;
    return {
      selectedDeviceId:
        typeof parsed.selectedDeviceId === 'string'
          ? parsed.selectedDeviceId
          : DEFAULT_PROFILE.selectedDeviceId,
      selectedOutputDeviceId:
        typeof parsed.selectedOutputDeviceId === 'string'
          ? parsed.selectedOutputDeviceId
          : DEFAULT_PROFILE.selectedOutputDeviceId,
      selectedChannel:
        parsed.selectedChannel === 'auto' ||
        parsed.selectedChannel === '0' ||
        parsed.selectedChannel === '1' ||
        parsed.selectedChannel === 'sum'
          ? parsed.selectedChannel
          : DEFAULT_PROFILE.selectedChannel,
      onsetThreshold:
        typeof parsed.onsetThreshold === 'number' &&
        parsed.onsetThreshold >= 0.005 &&
        parsed.onsetThreshold <= 0.3
          ? parsed.onsetThreshold
          : DEFAULT_PROFILE.onsetThreshold,
      latencyCompensationMs:
        typeof parsed.latencyCompensationMs === 'number' &&
        parsed.latencyCompensationMs >= -50 &&
        parsed.latencyCompensationMs <= 120
          ? Math.round(parsed.latencyCompensationMs)
          : DEFAULT_PROFILE.latencyCompensationMs,
      bpm:
        typeof parsed.bpm === 'number' && parsed.bpm >= 30 && parsed.bpm <= 240
          ? Math.round(parsed.bpm)
          : DEFAULT_PROFILE.bpm,
      subdivision:
        parsed.subdivision === 1 ||
        parsed.subdivision === 2 ||
        parsed.subdivision === 3 ||
        parsed.subdivision === 4
          ? parsed.subdivision
          : DEFAULT_PROFILE.subdivision,
      groovePattern:
        parsed.groovePattern === 'uniform' ||
        parsed.groovePattern === 'motown-pocket' ||
        parsed.groovePattern === 'funk-16th' ||
        parsed.groovePattern === 'shuffle-swing' ||
        parsed.groovePattern === 'octaves-8th'
          ? parsed.groovePattern
          : DEFAULT_PROFILE.groovePattern,
      soundMode:
        parsed.soundMode === 'click' || parsed.soundMode === 'drums'
          ? parsed.soundMode
          : DEFAULT_PROFILE.soundMode,
      bassGuideMode:
        parsed.bassGuideMode === 'off' ||
        parsed.bassGuideMode === 'call-response-1-1' ||
        parsed.bassGuideMode === 'call-response-1-3' ||
        parsed.bassGuideMode === 'demo-first' ||
        parsed.bassGuideMode === 'always'
          ? parsed.bassGuideMode
          : DEFAULT_PROFILE.bassGuideMode,
      clickPlacement:
        parsed.clickPlacement === 'all' ||
        parsed.clickPlacement === 'backbeat-2-4' ||
        parsed.clickPlacement === 'one-drop-1' ||
        parsed.clickPlacement === 'offbeat-and'
          ? parsed.clickPlacement
          : DEFAULT_PROFILE.clickPlacement,
      pocketWindowMs:
        typeof parsed.pocketWindowMs === 'number' &&
        parsed.pocketWindowMs >= 5 &&
        parsed.pocketWindowMs <= 50
          ? parsed.pocketWindowMs
          : DEFAULT_PROFILE.pocketWindowMs,
      pocketCenterMs:
        parsed.pocketCenterMs === 0 ||
        parsed.pocketCenterMs === 12 ||
        parsed.pocketCenterMs === -8
          ? parsed.pocketCenterMs
          : DEFAULT_PROFILE.pocketCenterMs,
      gapBars:
        parsed.gapBars === 0 || parsed.gapBars === 1 || parsed.gapBars === 2
          ? parsed.gapBars
          : DEFAULT_PROFILE.gapBars,
      speedTrainerStep:
        parsed.speedTrainerStep === 0 ||
        parsed.speedTrainerStep === 2 ||
        parsed.speedTrainerStep === 4
          ? parsed.speedTrainerStep
          : DEFAULT_PROFILE.speedTrainerStep,
      drillMode:
        parsed.drillMode === 'free' ||
        parsed.drillMode === 'root-cycle' ||
        parsed.drillMode === 'random-bar' ||
        parsed.drillMode === 'fixed-e' ||
        parsed.drillMode === 'fixed-a'
          ? parsed.drillMode
          : DEFAULT_PROFILE.drillMode,
      instrumentRange:
        parsed.instrumentRange === 'bass' ||
        parsed.instrumentRange === 'guitar' ||
        parsed.instrumentRange === 'full'
          ? parsed.instrumentRange
          : DEFAULT_PROFILE.instrumentRange,
      roundBars:
        parsed.roundBars === 0 ||
        parsed.roundBars === 4 ||
        parsed.roundBars === 8 ||
        parsed.roundBars === 16
          ? parsed.roundBars
          : DEFAULT_PROFILE.roundBars,
      autoContinue:
        typeof parsed.autoContinue === 'boolean'
          ? parsed.autoContinue
          : DEFAULT_PROFILE.autoContinue,
      visualGuide:
        parsed.visualGuide === 'none' ||
        parsed.visualGuide === 'glow' ||
        parsed.visualGuide === 'sweep'
          ? parsed.visualGuide
          : DEFAULT_PROFILE.visualGuide,
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

/**
 * Saves the current `GrooveLockProfile` to `localStorage`.
 */
export function saveProfile(profile: GrooveLockProfile): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Ignore storage quota or private-browsing exceptions
  }
}
