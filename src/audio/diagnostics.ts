import type { DetectedPluckEvent, LoopbackSummary } from '../dsp/types';
import type { TargetNoteEvent } from '../groove/timeline';
import type { ClockSnapshot, DiagnosticPcmChunk, ScheduledSound } from './audio-engine';
import { encodeWavChannels, median } from './take';

/**
 * Diagnostic recorder for offline timing analysis: captures both raw input channels plus the app's
 * own timing log (scheduled sounds, targets, detected plucks with raw and converted timestamps,
 * grades, loopback results, clock snapshots) and exports them as a stereo WAV + JSON pair.
 *
 * Time bases: the WAV starts at `wav.startInputTimeSec` on the `inputCtx` clock. Everything
 * scheduled on the output is logged on the `outputCtx` clock; use the logged clock offsets
 * (`outputCtx − inputCtx`) to convert between them.
 */

export const DIAGNOSTICS_MAX_SEC = 300;

/** Places chunks on the input clock (gaps stay silent) as two channel arrays. */
export function placeDiagnosticChunks(
  chunks: readonly DiagnosticPcmChunk[],
): { ch0: Float32Array; ch1: Float32Array; sampleRate: number; startInputTimeSec: number } | null {
  if (chunks.length === 0) {
    return null;
  }
  const sampleRate = chunks[0].sampleRate;
  const start = Math.min(...chunks.map((c) => c.inputTimeSec));
  const end = Math.max(...chunks.map((c) => c.inputTimeSec + c.ch0.length / sampleRate));
  const length = Math.max(0, Math.round((end - start) * sampleRate));
  const ch0 = new Float32Array(length);
  const ch1 = new Float32Array(length);
  for (const c of chunks) {
    const startIdx = Math.round((c.inputTimeSec - start) * sampleRate);
    for (let i = 0; i < c.ch0.length; i++) {
      const idx = startIdx + i;
      if (idx >= 0 && idx < length) {
        ch0[idx] = c.ch0[i];
        ch1[idx] = c.ch1[i];
      }
    }
  }
  return { ch0, ch1, sampleRate, startInputTimeSec: start };
}

interface GradedRecord {
  readonly targetId: string;
  readonly targetTimeSec: number;
  readonly offsetMs: number;
  readonly feelDeltaMs: number;
  readonly latencyCompensationMs: number;
  readonly judgment: string;
}

/** Collects one diagnostic session. All `add*` methods are cheap and safe to call at any rate. */
export class DiagnosticsRecorder {
  public readonly startedAt = new Date();
  private readonly chunks: DiagnosticPcmChunk[] = [];
  private readonly sounds: ScheduledSound[] = [];
  private readonly targets: TargetNoteEvent[] = [];
  private readonly plucks: DetectedPluckEvent[] = [];
  private readonly graded: GradedRecord[] = [];
  private readonly snapshots: ClockSnapshot[] = [];
  private readonly loopbacks: (LoopbackSummary & { atPerfMs: number })[] = [];
  private readonly notes: { atPerfMs: number; text: string }[] = [];

  public addChunk(chunk: DiagnosticPcmChunk): void {
    this.chunks.push(chunk);
  }

  public addSound(sound: ScheduledSound): void {
    this.sounds.push(sound);
  }

  public addTarget(target: TargetNoteEvent): void {
    this.targets.push(target);
  }

  public addPluck(pluck: DetectedPluckEvent): void {
    this.plucks.push(pluck);
  }

  public addGraded(record: GradedRecord): void {
    this.graded.push(record);
  }

  public addSnapshot(snapshot: ClockSnapshot): void {
    this.snapshots.push(snapshot);
  }

  public addLoopback(summary: LoopbackSummary): void {
    this.loopbacks.push({ ...summary, atPerfMs: performance.now() });
  }

  public addNote(text: string): void {
    this.notes.push({ atPerfMs: performance.now(), text });
  }

  /** Seconds of audio captured so far. */
  public durationSec(): number {
    if (this.chunks.length === 0) return 0;
    const first = this.chunks[0];
    const last = this.chunks[this.chunks.length - 1];
    return last.inputTimeSec + last.ch0.length / last.sampleRate - first.inputTimeSec;
  }

  public pluckCount(): number {
    return this.plucks.length;
  }

  /** Builds the stereo WAV (L = input 1, R = input 2) and the JSON timing log. */
  public export(meta: Record<string, unknown>, wavFileName: string): { wav: Blob | null; json: Blob } {
    const placed = placeDiagnosticChunks(this.chunks);
    const offsets = this.chunks.map((c) => c.clockOffsetSec);
    const log = {
      format: 'groovelock-diagnostics',
      version: 1,
      createdAt: this.startedAt.toISOString(),
      exportedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      meta,
      wav: placed
        ? {
            file: wavFileName,
            sampleRate: placed.sampleRate,
            startInputTimeSec: placed.startInputTimeSec,
            channels: ['input 1 (ch0)', 'input 2 (ch1)'],
            durationSec: placed.ch0.length / placed.sampleRate,
          }
        : null,
      timeBases:
        'WAV and plucks[].inputOnsetTimeSec use the inputCtx clock; sounds, targets, graded and ' +
        'plucks[].rawOnsetTimeSec use the outputCtx clock. outputTime = inputTime + clockOffsetSec.',
      medianClockOffsetSec: offsets.length > 0 ? median(offsets) : null,
      chunkTiming: this.chunks.map((c) => ({
        inputTimeSec: c.inputTimeSec,
        clockOffsetSec: c.clockOffsetSec,
        frames: c.ch0.length,
      })),
      clockSnapshots: this.snapshots,
      sounds: this.sounds,
      targets: this.targets,
      plucks: this.plucks,
      graded: this.graded,
      loopbacks: this.loopbacks,
      notes: this.notes,
    };
    const json = new Blob([JSON.stringify(log, null, 1)], { type: 'application/json' });
    const wav = placed
      ? new Blob([encodeWavChannels([placed.ch0, placed.ch1], placed.sampleRate)], { type: 'audio/wav' })
      : null;
    return { wav, json };
  }
}
