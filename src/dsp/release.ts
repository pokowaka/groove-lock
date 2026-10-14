/**
 * Finds where each played note ends (release timing), from the cycle-safe sustain envelope.
 *
 * A bass note left alone barely decays (a held low E loses about 0–1 dB per 100 ms). A deliberate
 * mute is fast: on real Scarlett recordings the level falls about 40 dB in 100–150 ms. So a note
 * ends where the envelope starts a fast fall (≥ `DROP_DB` within `DROP_WINDOW_SEC`) that then
 * stays down (`CONFIRM_SEC`), so a brief dip inside a note is not a release. A note that is cut by
 * the next note ends at that next onset; a note left to ring ends when it has faded `FADE_DB` below
 * its peak.
 *
 * The reported time is the start of the fall (the moment the player muted), corrected for the lag
 * of the trailing envelope window.
 */

export type ReleaseKind = 'muted' | 'next-note' | 'faded';

export interface ReleaseEvent {
  /** Onset of the note that ended (same clock as the onsets fed in). */
  readonly onsetTimeSec: number;
  /** When the note ended. */
  readonly releaseTimeSec: number;
  readonly kind: ReleaseKind;
}

/** A fall counts as a mute once the level is this far below where it started falling. */
const DROP_DB = 12;
/** ...and it got there within this time. Natural decay never falls that fast. */
const DROP_WINDOW_SEC = 0.08;
/** The fall starts when the level goes this far below the recent level. */
const START_DB = 3;
/** After the drop, the level must stay at least `STAY_DB` down for this long. */
const CONFIRM_SEC = 0.03;
const STAY_DB = 9;
/** A note left ringing counts as ended once it has faded this far below its peak. */
const FADE_DB = 30;
/** The recent level is the envelope peak over this window. */
const REF_WINDOW_SEC = 0.06;
/** Ignore the attack: no release is looked for this soon after the onset. */
const ATTACK_SEC = 0.03;

const toDb = (linear: number): number => 20 * Math.log10(Math.max(linear, 1e-7));

/** Capacity of the recent-frames ring (enough for `REF_WINDOW_SEC` at 128-sample frames). */
const RECENT_CAPACITY = 64;

interface OpenNote {
  readonly onsetTimeSec: number;
  peakDb: number;
  /** Start of a fall in progress, with the level it fell from. */
  fallStartSec: number | null;
  fallFromDb: number;
  /** Time the fall reached `DROP_DB`, awaiting confirmation. */
  droppedAtSec: number | null;
}

export class ReleaseTracker {
  private note: OpenNote | null = null;
  /** Recent envelope frames (time, dB) for the sliding reference level; a fixed ring, so the
   * audio thread does not allocate per frame. */
  private readonly recentT = new Float64Array(RECENT_CAPACITY);
  private readonly recentDb = new Float64Array(RECENT_CAPACITY);
  private recentStart = 0;
  private recentCount = 0;

  /**
   * @param lagSec How far the envelope lags the signal; subtracted from reported release times.
   */
  constructor(private readonly lagSec = 0) {}

  /**
   * A new note started. Returns the release of the previous note if it was still sounding
   * (cut by this one).
   */
  public noteOn(onsetTimeSec: number): ReleaseEvent | null {
    const prev = this.note;
    this.note = {
      onsetTimeSec,
      peakDb: -Infinity,
      fallStartSec: null,
      fallFromDb: 0,
      droppedAtSec: null,
    };
    this.recentCount = 0;
    return prev
      ? { onsetTimeSec: prev.onsetTimeSec, releaseTimeSec: onsetTimeSec, kind: 'next-note' }
      : null;
  }

  /** Feeds one envelope frame (linear amplitude) at `timeSec`; returns a release when found. */
  public processEnvelope(envelope: number, timeSec: number): ReleaseEvent | null {
    const note = this.note;
    if (!note) {
      return null;
    }
    const db = toDb(envelope);
    this.pushRecent(timeSec, db);
    note.peakDb = Math.max(note.peakDb, db);
    if (timeSec - note.onsetTimeSec < ATTACK_SEC) {
      return null;
    }

    if (db < note.peakDb - FADE_DB) {
      return this.close(note, note.fallStartSec ?? timeSec, note.fallStartSec !== null ? 'muted' : 'faded');
    }

    if (note.droppedAtSec !== null) {
      if (db > note.fallFromDb - STAY_DB) {
        // Came back up: a dip inside the note, not a release.
        note.fallStartSec = null;
        note.droppedAtSec = null;
      } else if (timeSec - note.droppedAtSec >= CONFIRM_SEC) {
        return this.close(note, note.fallStartSec ?? note.droppedAtSec, 'muted');
      }
      return null;
    }

    if (note.fallStartSec === null) {
      let ref = -Infinity;
      for (let k = 0; k < this.recentCount; k++) {
        ref = Math.max(ref, this.recentDb[(this.recentStart + k) % RECENT_CAPACITY]);
      }
      if (db < ref - START_DB) {
        note.fallStartSec = timeSec;
        note.fallFromDb = ref;
      }
      return null;
    }

    if (db >= note.fallFromDb - START_DB) {
      note.fallStartSec = null;
    } else if (db <= note.fallFromDb - DROP_DB) {
      note.droppedAtSec = timeSec;
    } else if (timeSec - note.fallStartSec > DROP_WINDOW_SEC) {
      // Too slow for a mute: natural decay. Look for a new fall from here.
      note.fallStartSec = null;
    }
    return null;
  }

  private pushRecent(timeSec: number, db: number): void {
    if (this.recentCount === RECENT_CAPACITY) {
      this.recentStart = (this.recentStart + 1) % RECENT_CAPACITY;
      this.recentCount--;
    }
    const idx = (this.recentStart + this.recentCount) % RECENT_CAPACITY;
    this.recentT[idx] = timeSec;
    this.recentDb[idx] = db;
    this.recentCount++;
    while (this.recentCount > 0 && this.recentT[this.recentStart] < timeSec - REF_WINDOW_SEC) {
      this.recentStart = (this.recentStart + 1) % RECENT_CAPACITY;
      this.recentCount--;
    }
  }

  private close(note: OpenNote, releaseTimeSec: number, kind: ReleaseKind): ReleaseEvent {
    this.note = null;
    this.recentCount = 0;
    return {
      onsetTimeSec: note.onsetTimeSec,
      releaseTimeSec: Math.max(note.onsetTimeSec, releaseTimeSec - this.lagSec),
      kind,
    };
  }
}
