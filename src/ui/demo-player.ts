import { describeBassVoiceNote, frequencyToPitchEstimate } from '../dsp/pitch-utils';
import type { DetectedPluckEvent, InstrumentRange } from '../dsp/types';
import type { TargetNoteEvent } from '../groove/timeline';

/**
 * Development aid enabled with `?demo` in the URL: synthesizes plausible plucks for every graded
 * target so the Play view can be previewed without an instrument. Simulates a slightly laid-back
 * player with ~7 ms jitter, a weak spot on the last off-beat, and the occasional missed note.
 */
export class DemoPlayer {
  private readonly deliver: (pluck: DetectedPluckEvent) => void;
  private readonly readClock: () => number | null;
  private readonly readLatencyMs: () => number;
  private readonly readRange: () => InstrumentRange;

  constructor(opts: {
    deliver: (pluck: DetectedPluckEvent) => void;
    readClock: () => number | null;
    readLatencyMs: () => number;
    readRange: () => InstrumentRange;
  }) {
    this.deliver = opts.deliver;
    this.readClock = opts.readClock;
    this.readLatencyMs = opts.readLatencyMs;
    this.readRange = opts.readRange;
  }

  /** Schedules a synthetic pluck for a target that the grader will evaluate. */
  public onTarget(target: TargetNoteEvent): void {
    if (Math.random() < 0.03) {
      return;
    }
    const weakSpot = target.beatInBar === 3 && target.subIndex > 0 ? -12 : 0;
    const offsetMs = 4 + weakSpot + gaussian() * 7;
    const rawOnsetTimeSec =
      target.timeSec + offsetMs / 1000 + this.readLatencyMs() / 1000;
    const now = this.readClock() ?? 0;
    const delayMs = Math.max(0, (rawOnsetTimeSec - now) * 1000 + 40);
    const voice = describeBassVoiceNote(target.expectedNote, this.readRange());
    const pitch = frequencyToPitchEstimate(voice.freqHz * (1 + gaussian() * 0.002), 0.95);
    window.setTimeout(() => {
      this.deliver({ rawOnsetTimeSec, pitch, peakRms: 0.08 });
    }, delayMs);
  }
}

function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
