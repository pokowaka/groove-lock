import { describeBassVoiceNote, frequencyToPitchEstimate } from '../dsp/pitch-utils';
import type { ReleaseEvent } from '../dsp/release';
import type { DetectedPluckEvent, InstrumentRange } from '../dsp/types';
import type { TargetNoteEvent } from '../groove/timeline';

/**
 * Development aid enabled with `?demo` in the URL: synthesizes plausible plucks for every graded
 * target so the Play view can be previewed without an instrument. Simulates a slightly laid-back
 * player with ~7 ms jitter, a weak spot on the last off-beat, and the occasional missed note.
 * Notes end a little early (≈ 25 ms short, ±20 ms) when the written length is known.
 * `?demoLatency=<ms>` sets the simulated hardware round-trip latency (default 18 ms, the default
 * compensation), e.g. `250` to reproduce an uncalibrated high-latency setup.
 */
export class DemoPlayer {
  private readonly deliver: (pluck: DetectedPluckEvent) => void;
  private readonly readClock: () => number | null;
  private readonly hardwareLatencyMs: number;
  private readonly readRange: () => InstrumentRange;
  private readonly deliverRelease: ((release: ReleaseEvent) => void) | null;
  private readonly readLengthSec: ((target: TargetNoteEvent) => number | null) | null;

  constructor(opts: {
    deliver: (pluck: DetectedPluckEvent) => void;
    readClock: () => number | null;
    hardwareLatencyMs: number;
    readRange: () => InstrumentRange;
    deliverRelease?: (release: ReleaseEvent) => void;
    /** Written length of the target's note in seconds, or `null` when lengths are not graded. */
    readLengthSec?: (target: TargetNoteEvent) => number | null;
  }) {
    this.deliver = opts.deliver;
    this.readClock = opts.readClock;
    this.hardwareLatencyMs = opts.hardwareLatencyMs;
    this.readRange = opts.readRange;
    this.deliverRelease = opts.deliverRelease ?? null;
    this.readLengthSec = opts.readLengthSec ?? null;
  }

  /** Schedules a synthetic pluck for a target that the grader will evaluate. */
  public onTarget(target: TargetNoteEvent): void {
    if (Math.random() < 0.03) {
      return;
    }
    const weakSpot = target.beatInBar === 3 && target.subIndex > 0 ? -12 : 0;
    const offsetMs = 4 + weakSpot + gaussian() * 7;
    const rawOnsetTimeSec =
      target.timeSec + offsetMs / 1000 + this.hardwareLatencyMs / 1000;
    const now = this.readClock() ?? 0;
    const delayMs = Math.max(0, (rawOnsetTimeSec - now) * 1000 + 40);
    const voice = describeBassVoiceNote(target.expectedNote, this.readRange());
    const pitch = frequencyToPitchEstimate(voice.freqHz * (1 + gaussian() * 0.002), 0.95);
    window.setTimeout(() => {
      this.deliver({ rawOnsetTimeSec, pitch, peakRms: 0.08 });
    }, delayMs);

    const lengthSec = this.readLengthSec?.(target) ?? null;
    if (lengthSec !== null && this.deliverRelease) {
      const releaseTimeSec =
        target.timeSec + this.hardwareLatencyMs / 1000 + Math.max(0.04, lengthSec - 0.025 + gaussian() * 0.02);
      const releaseDelayMs = Math.max(delayMs + 5, (releaseTimeSec - now) * 1000 + 50);
      const deliverRelease = this.deliverRelease;
      window.setTimeout(() => {
        deliverRelease({ onsetTimeSec: rawOnsetTimeSec, releaseTimeSec, kind: 'muted' });
      }, releaseDelayMs);
    }
  }
}

function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
