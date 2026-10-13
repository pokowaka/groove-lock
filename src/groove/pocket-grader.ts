import type { DetectedPluckEvent, NoteClass } from '../dsp/types';
import type { Subdivision, TargetNoteEvent } from './timeline';

/**
 * Micro-timing classification relative to the nearest `TargetNoteEvent` and `pocketCenterMs`:
 * - `'pocket'`: Within `[pocketCenterMs - pocketWindowMs, pocketCenterMs + pocketWindowMs]`.
 * - `'rushing'`: Played earlier than the target pocket zone (`offsetMs < pocketCenterMs - pocketWindowMs`).
 * - `'dragging'`: Played later than the target pocket zone (`offsetMs > pocketCenterMs + pocketWindowMs`).
 */
export type TimingVerdict = 'pocket' | 'rushing' | 'dragging';

/**
 * Graded record of a single plucked note matched against a `TargetNoteEvent`.
 */
export interface GradedPluckEntry {
  /** The scheduled timeline event this pluck was matched against. */
  readonly targetEvent: TargetNoteEvent;
  /** Human-readable beat coordinate (e.g. `"Beat 1"` or `"3.2"`). */
  readonly beatLabel: string;
  /** Detected note name (`"E1"`) or `"Muted"` if percussive. */
  readonly noteLabel: string;
  /** Signed timing error in milliseconds relative to the grid beat (`< 0` = early, `> 0` = late). */
  readonly offsetMs: number;
  /** Signed timing error relative to the intentional pocket center (`offsetMs - pocketCenterMs`). */
  readonly feelDeltaMs: number;
  /** `true` if `Math.abs(offsetMs - pocketCenterMs) <= pocketWindowMs`. */
  readonly inPocket: boolean;
  /** Categorical timing verdict (`'pocket'`, `'rushing'`, or `'dragging'`). */
  readonly verdict: TimingVerdict;
  /** `true` if `targetNote === 'ANY'` or the detected pitch class matched `targetNote`. */
  readonly noteMatched: boolean;
  /** Required pitch class on this beat, or `'ANY'`. */
  readonly targetNote: NoteClass | 'ANY';
}

/**
 * Rolling session groove statistics computed by `PocketGrader`.
 */
export interface SessionStats {
  /** Number of evaluated notes in the rolling window (up to 64). */
  readonly totalHits: number;
  /** Percentage of evaluated notes inside `pocketCenterMs ± pocketWindowMs` (`0..100`), or `null` if 0 hits. */
  readonly inPocketPct: number | null;
  /** Mean signed timing offset in ms relative to 0ms grid center. */
  readonly meanOffsetMs: number | null;
  /** Timing jitter standard deviation ($\sigma$) in ms — the primary metric of groove consistency. */
  readonly stdDevMs: number | null;
  /** Count of plucks that matched the active target pitch class. */
  readonly noteMatches: number;
  /** Total plucks evaluated while a specific target pitch class was active. */
  readonly noteAttempts: number;
}

const MAX_TIMELINE_EVENTS = 48;
const MAX_OFFSET_WINDOW = 64;
const MAX_HISTORY_ENTRIES = 24;

/**
 * Evaluates detected instrument plucks against a rolling timeline of `TargetNoteEvent`s
 * and maintains session micro-timing statistics (in-pocket rate, mean tendency, and $\sigma$ jitter).
 *
 * Designed to be source-agnostic: any producer of `TargetNoteEvent`s (the built-in
 * metronome/pattern scheduler or a future song/YouTube beatmap loader) can feed `pushTargetEvent()`.
 */
export class PocketGrader {
  private timelineEvents: TargetNoteEvent[] = [];
  /** Ids of targets that already received their graded hit (each target is graded once). */
  private gradedTargetIds = new Set<string>();
  private history: GradedPluckEntry[] = [];
  private offsetsMs: number[] = [];
  private noteMatches = 0;
  private noteAttempts = 0;

  // Speed Trainer bar-window tracking
  private speedTrainerHitsInWindow = 0;
  private speedTrainerPocketInWindow = 0;
  private speedTrainerActiveBars = new Set<number>();

  /**
   * Appends a newly scheduled `TargetNoteEvent` to the rolling lookup window.
   */
  public pushTargetEvent(event: TargetNoteEvent): void {
    this.timelineEvents.push(event);
    if (this.timelineEvents.length > MAX_TIMELINE_EVENTS) {
      const dropped = this.timelineEvents.shift();
      if (dropped) this.gradedTargetIds.delete(dropped.id);
    }
  }

  /**
   * Clears all scheduled timeline events (called when stopping or restarting transport).
   */
  public clearTimeline(): void {
    this.timelineEvents = [];
    this.gradedTargetIds.clear();
    this.resetSpeedTrainerWindow();
  }

  /**
   * Resets the 4-bar Speed Trainer accumulation window.
   */
  public resetSpeedTrainerWindow(): void {
    this.speedTrainerHitsInWindow = 0;
    this.speedTrainerPocketInWindow = 0;
    this.speedTrainerActiveBars.clear();
  }

  /**
   * Resets all accumulated session timing statistics and pluck history.
   */
  public resetStats(): void {
    this.history = [];
    this.offsetsMs = [];
    this.noteMatches = 0;
    this.noteAttempts = 0;
    this.resetSpeedTrainerWindow();
  }

  /**
   * Finds the scheduled `TargetNoteEvent` closest in time to `checkTimeSec`.
   *
   * @param checkTimeSec Latency-compensated pluck timestamp in `outputCtx` seconds.
   * @param quarterNotesOnly When `true` (used by Tap Calibration), ignores subdivision off-beats.
   */
  public findNearestTarget(
    checkTimeSec: number,
    quarterNotesOnly = false,
  ): { target: TargetNoteEvent; offsetMs: number } | null {
    let bestTarget: TargetNoteEvent | null = null;
    let minAbsDiffSec = Infinity;
    let bestDiffSec = 0;

    for (const pt of this.timelineEvents) {
      if (quarterNotesOnly && pt.subIndex !== 0) {
        continue;
      }
      const diffSec = checkTimeSec - pt.timeSec;
      const absDiff = Math.abs(diffSec);
      if (absDiff < minAbsDiffSec) {
        minAbsDiffSec = absDiff;
        bestTarget = pt;
        bestDiffSec = diffSec;
      }
    }

    if (!bestTarget) {
      return null;
    }

    return {
      target: bestTarget,
      offsetMs: bestDiffSec * 1000,
    };
  }

  /**
   * Subtracts `latencyCompensationMs` from `pluck.rawOnsetTimeSec`, matches the pluck
   * to the nearest `TargetNoteEvent`, and records the graded entry relative to
   * `pocketCenterMs ± pocketWindowMs`.
   *
   * Each target is graded at most once: a further pluck whose nearest target already has a hit
   * (an extra note, or a detector re-trigger) is ignored instead of being scored as very late.
   *
   * @returns The `GradedPluckEntry`, or `null` if no timeline event is within half a grid step or
   *   the nearest target was already graded.
   */
  public evaluatePluck(
    pluck: DetectedPluckEvent,
    params: {
      latencyCompensationMs: number;
      bpm: number;
      subdivision: Subdivision;
      pocketWindowMs: number;
      pocketCenterMs?: number;
    },
  ): GradedPluckEntry | null {
    if (this.timelineEvents.length === 0) {
      return null;
    }

    const pocketCenterMs = params.pocketCenterMs ?? 0;
    const compensatedTimeSec =
      pluck.rawOnsetTimeSec - params.latencyCompensationMs / 1000;
    const match = this.findNearestTarget(compensatedTimeSec, false);
    if (!match) {
      return null;
    }

    const stepDurationMs = 60000 / params.bpm / params.subdivision;
    const maxCaptureWindowMs = Math.max(
      stepDurationMs * 0.65,
      (60000 / params.bpm) * 0.45,
    );
    if (Math.abs(match.offsetMs) > maxCaptureWindowMs) {
      return null;
    }
    if (this.gradedTargetIds.has(match.target.id)) {
      return null;
    }
    this.gradedTargetIds.add(match.target.id);

    const offsetMs = match.offsetMs;
    const feelDeltaMs = offsetMs - pocketCenterMs;
    const inPocket = Math.abs(feelDeltaMs) <= params.pocketWindowMs;
    const verdict: TimingVerdict = inPocket
      ? 'pocket'
      : feelDeltaMs < 0
        ? 'rushing'
        : 'dragging';

    const expectedNote = match.target.expectedNote;
    let noteMatched = true;
    if (expectedNote !== 'ANY') {
      this.noteAttempts++;
      if (pluck.pitch && pluck.pitch.noteClass === expectedNote) {
        this.noteMatches++;
        noteMatched = true;
      } else {
        noteMatched = false;
      }
    }

    this.offsetsMs.push(offsetMs);
    if (this.offsetsMs.length > MAX_OFFSET_WINDOW) {
      this.offsetsMs.shift();
    }

    this.speedTrainerHitsInWindow++;
    if (inPocket && noteMatched) {
      this.speedTrainerPocketInWindow++;
    }
    this.speedTrainerActiveBars.add(match.target.barNumber);

    const entry: GradedPluckEntry = {
      targetEvent: match.target,
      beatLabel: match.target.beatLabel,
      noteLabel: pluck.pitch ? pluck.pitch.fullName : 'Muted',
      offsetMs,
      feelDeltaMs,
      inPocket,
      verdict,
      noteMatched,
      targetNote: expectedNote,
    };

    this.history.unshift(entry);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      this.history.pop();
    }

    return entry;
  }

  /**
   * Checks whether the player has completed at least `targetBarCount` active bars
   * with `>= minAccuracyRatio` (default 85%) in-pocket accuracy. If met, resets the
   * Speed Trainer window and returns `true` so the caller can step up BPM.
   */
  public consumeSpeedTrainerStepUpIfReady(
    targetBarCount = 4,
    minAccuracyRatio = 0.85,
  ): boolean {
    if (this.speedTrainerActiveBars.size < targetBarCount) {
      return false;
    }
    if (this.speedTrainerHitsInWindow < targetBarCount * 2) {
      return false;
    }
    const ratio =
      this.speedTrainerPocketInWindow / this.speedTrainerHitsInWindow;
    this.resetSpeedTrainerWindow();
    return ratio >= minAccuracyRatio;
  }

  /**
   * Returns the most recent graded plucks (up to 24, newest first).
   */
  public getHistory(): readonly GradedPluckEntry[] {
    return this.history;
  }

  /**
   * Computes aggregate session metrics over the rolling 64-pluck window.
   */
  public getStats(pocketWindowMs: number, pocketCenterMs = 0): SessionStats {
    const count = this.offsetsMs.length;
    if (count === 0) {
      return {
        totalHits: 0,
        inPocketPct: null,
        meanOffsetMs: null,
        stdDevMs: null,
        noteMatches: this.noteMatches,
        noteAttempts: this.noteAttempts,
      };
    }

    let pocketHits = 0;
    let sum = 0;
    for (const v of this.offsetsMs) {
      sum += v;
      if (Math.abs(v - pocketCenterMs) <= pocketWindowMs) {
        pocketHits++;
      }
    }

    const meanOffsetMs = sum / count;
    let sqDiffSum = 0;
    for (const v of this.offsetsMs) {
      const d = v - meanOffsetMs;
      sqDiffSum += d * d;
    }
    const stdDevMs = Math.sqrt(sqDiffSum / count);
    const inPocketPct = Math.round((pocketHits / count) * 100);

    return {
      totalHits: count,
      inPocketPct,
      meanOffsetMs,
      stdDevMs,
      noteMatches: this.noteMatches,
      noteAttempts: this.noteAttempts,
    };
  }
}
