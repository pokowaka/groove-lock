import type { HitJudgment } from '../groove/scoring';
import type { RecordedPcmChunk, ScheduledSound } from './audio-engine';
import { StudioDrumSynth } from './drum-synth';

/**
 * Round recordings ("takes"): the player's instrument audio plus a sample-exact re-render of the
 * backing track, aligned on the output clock so playback sounds exactly like what was graded.
 *
 * Data flow: the engine streams instrument PCM chunks (input clock) and logs scheduled sounds
 * (output clock) during a round. After the round, `assembleTrack` places the PCM on the output
 * timeline (shifted by the latency compensation, like the grader), `renderSoundsOffline`
 * re-synthesizes the backing track, and `TakePlayer` plays both with an adjustable mix.
 */

/** What the player hears during playback. */
export type PlaybackMode = 'mix' | 'bass' | 'drums';

/** A graded note marker on the take timeline. */
export interface TakeTick {
  /** Seconds from the start of the take. */
  readonly timeSec: number;
  readonly judgment: HitJudgment;
}

export interface Take {
  readonly drums: AudioBuffer;
  /** `null` when no instrument input was recorded. */
  readonly bass: AudioBuffer | null;
  readonly durationSec: number;
  readonly ticks: readonly TakeTick[];
}

/** A take window on the `outputCtx` clock. */
export interface TakeWindow {
  readonly startSec: number;
  readonly endSec: number;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Places recorded instrument chunks on the output timeline.
 *
 * @param chunks Chunks in any order, all at the same sample rate.
 * @param opts.shiftSec Extra shift applied to the audio (use `−latencyCompensationMs / 1000` so the
 *   audio sits where the grader judged it).
 * @return Mono samples covering `[startSec, endSec)`, or `null` without chunks.
 */
export function assembleTrack(
  chunks: readonly RecordedPcmChunk[],
  opts: TakeWindow & { readonly shiftSec: number },
): { data: Float32Array<ArrayBuffer>; sampleRate: number } | null {
  if (chunks.length === 0) {
    return null;
  }
  const sampleRate = chunks[0].sampleRate;
  const clockOffsetSec = median(chunks.map((c) => c.clockOffsetSec));
  const length = Math.max(0, Math.round((opts.endSec - opts.startSec) * sampleRate));
  const data = new Float32Array(length);
  for (const c of chunks) {
    const startIdx = Math.round(
      (c.inputTimeSec + clockOffsetSec + opts.shiftSec - opts.startSec) * sampleRate,
    );
    for (let i = 0; i < c.samples.length; i++) {
      const idx = startIdx + i;
      if (idx >= 0 && idx < length) {
        data[idx] = c.samples[i];
      }
    }
  }
  return { data, sampleRate };
}

/**
 * Scales samples in place so the peak reaches `target`, boosting at most `maxGain` times.
 *
 * @return The gain applied (1 for silence).
 */
export function normalizePeak(data: Float32Array, target = 0.8, maxGain = 8): number {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak === 0) {
    return 1;
  }
  const gain = Math.min(maxGain, target / peak);
  for (let i = 0; i < data.length; i++) {
    data[i] *= gain;
  }
  return gain;
}

/** Drum and bass gains for a playback mode. */
export function mixGains(mode: PlaybackMode): { drums: number; bass: number } {
  switch (mode) {
    case 'mix':
      return { drums: 0.8, bass: 1 };
    case 'bass':
      return { drums: 0, bass: 1 };
    case 'drums':
      return { drums: 1, bass: 0 };
  }
}

/** Encodes mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  return encodeWavChannels([samples], sampleRate);
}

/**
 * Encodes one or more channels of float samples as an interleaved 16-bit PCM WAV file. Shorter
 * channels are padded with silence.
 */
export function encodeWavChannels(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = Math.max(1, channels.length);
  const frames = Math.max(0, ...channels.map((c) => c.length));
  const blockAlign = numChannels * 2;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const raw = channels[c]?.[i] ?? 0;
      const s = Math.max(-1, Math.min(1, raw));
      view.setInt16(offset, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      offset += 2;
    }
  }
  return buffer;
}

/** Wraps mono samples in an `AudioBuffer`. */
export function toAudioBuffer(data: Float32Array<ArrayBuffer>, sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({ length: Math.max(1, data.length), sampleRate, numberOfChannels: 1 });
  buffer.copyToChannel(data, 0);
  return buffer;
}

/**
 * Re-synthesizes logged sounds that fall inside the window into a mono `AudioBuffer`.
 */
export async function renderSoundsOffline(
  sounds: readonly ScheduledSound[],
  window: TakeWindow,
  sampleRate: number,
): Promise<AudioBuffer> {
  const durationSec = window.endSec - window.startSec;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.round(durationSec * sampleRate)), sampleRate);
  const synth = new StudioDrumSynth();
  for (const s of sounds) {
    const t = s.timeSec - window.startSec;
    if (t < 0 || t >= durationSec) continue;
    switch (s.kind) {
      case 'click':
        synth.scheduleClick(ctx, t, s.variant);
        break;
      case 'kick':
        synth.scheduleKick(ctx, t, s.level);
        break;
      case 'snare':
        synth.scheduleSnare(ctx, t, s.level);
        break;
      case 'hihat':
        synth.scheduleHiHat(ctx, t, s.level);
        break;
      case 'bass':
        synth.scheduleBassNote(ctx, t, s.freqHz, s.gateSec, s.level);
        break;
      case 'ping':
        break;
    }
  }
  return ctx.startRendering();
}

/** Mixes a take down to one channel (current mix balance) and encodes it as WAV. */
export async function mixTakeToWav(take: Take): Promise<Blob> {
  const sr = take.drums.sampleRate;
  const ctx = new OfflineAudioContext(1, take.drums.length, sr);
  const gains = mixGains('mix');
  const addSource = (buffer: AudioBuffer, gain: number): void => {
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = buffer;
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    src.start(0);
  };
  addSource(take.drums, gains.drums);
  if (take.bass) addSource(take.bass, gains.bass);
  const rendered = await ctx.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), sr)], { type: 'audio/wav' });
}

/**
 * Plays takes on the live output context with a switchable mix.
 *
 * Invariant: at most one take plays at a time; `stop()` never fires `onEnded`.
 */
export class TakePlayer {
  private readonly getContext: () => AudioContext | null;
  private sources: AudioBufferSourceNode[] = [];
  private drumsGain: GainNode | null = null;
  private bassGain: GainNode | null = null;
  private startedAtSec = 0;
  private durationSec = 0;
  private playing = false;
  private playToken = 0;

  constructor(getContext: () => AudioContext | null) {
    this.getContext = getContext;
  }

  /**
   * Plays a take from the start.
   *
   * @param onEnded Called when playback reaches the end (not when stopped).
   * @return `false` if there is no output context.
   */
  public play(take: Take, mode: PlaybackMode, onEnded?: () => void): boolean {
    this.stop();
    const ctx = this.getContext();
    if (!ctx) {
      return false;
    }
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const gains = mixGains(mode);
    const startAt = ctx.currentTime + 0.05;
    const token = ++this.playToken;

    const connect = (buffer: AudioBuffer, gainValue: number): GainNode => {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buffer;
      gain.gain.value = gainValue;
      src.connect(gain).connect(ctx.destination);
      src.start(startAt);
      this.sources.push(src);
      return gain;
    };
    this.drumsGain = connect(take.drums, gains.drums);
    this.bassGain = take.bass ? connect(take.bass, gains.bass) : null;
    this.sources[0].onended = () => {
      if (token === this.playToken && this.playing) {
        this.playing = false;
        onEnded?.();
      }
    };
    this.startedAtSec = startAt;
    this.durationSec = take.durationSec;
    this.playing = true;
    return true;
  }

  public setMode(mode: PlaybackMode): void {
    const ctx = this.getContext();
    if (!ctx) return;
    const gains = mixGains(mode);
    this.drumsGain?.gain.setTargetAtTime(gains.drums, ctx.currentTime, 0.02);
    this.bassGain?.gain.setTargetAtTime(gains.bass, ctx.currentTime, 0.02);
  }

  public stop(): void {
    this.playToken++;
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // Already stopped.
      }
    }
    this.sources = [];
    this.drumsGain = null;
    this.bassGain = null;
    this.playing = false;
  }

  public isPlaying(): boolean {
    return this.playing;
  }

  /** Seconds into the take of the audio currently being heard (compensates output latency). */
  public positionSec(): number {
    const ctx = this.getContext();
    if (!ctx || !this.playing) return 0;
    const latency = ctx.outputLatency || ctx.baseLatency || 0;
    return Math.min(this.durationSec, Math.max(0, ctx.currentTime - latency - this.startedAtSec));
  }
}
