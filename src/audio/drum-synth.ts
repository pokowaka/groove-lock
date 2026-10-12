/**
 * Pure Web Audio studio click and drum kit synthesizer (`src/audio/drum-synth.ts`).
 *
 * Synthesizes punchy, zero-latency studio Kick, Snare, Hi-Hat, and Metronome Click
 * transients procedurally on `outputCtx` without requiring external audio sample files.
 */
export class StudioDrumSynth {
  private noiseBuffer: AudioBuffer | null = null;
  private noiseBufferSampleRate = 0;

  /**
   * Lazily generates and caches a 1-second white-noise `AudioBuffer` for snare and hi-hat synthesis.
   */
  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBufferSampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const length = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic LCG pseudo-random white noise so synthesis is reproducible
    let seed = 0x6d2b79f5;
    for (let i = 0; i < length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      data[i] = (seed / 0x7fffffff) * 0.9;
    }
    this.noiseBuffer = buffer;
    this.noiseBufferSampleRate = ctx.sampleRate;
    return buffer;
  }

  /**
   * Schedules the classic pitched studio metronome click (`1320 Hz` downbeat, `880 Hz` quarter,
   * `587.33 Hz` subdivision).
   */
  public scheduleClick(
    ctx: AudioContext,
    timeSec: number,
    kind: 'downbeat' | 'quarter' | 'subdivision',
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (kind === 'downbeat') {
      osc.frequency.setValueAtTime(1320, timeSec);
      gain.gain.setValueAtTime(0.32, timeSec);
    } else if (kind === 'quarter') {
      osc.frequency.setValueAtTime(880, timeSec);
      gain.gain.setValueAtTime(0.22, timeSec);
    } else {
      osc.frequency.setValueAtTime(587.33, timeSec);
      gain.gain.setValueAtTime(0.09, timeSec);
    }

    gain.gain.exponentialRampToValueAtTime(0.0008, timeSec + 0.032);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(timeSec);
    osc.stop(timeSec + 0.036);
  }

  /**
   * Schedules a punchy studio kick drum at `timeSec`:
   * - Pitch-swept sine fundamental (`140 Hz -> 46 Hz` in 65 ms)
   * - Short beater attack transient (`920 Hz -> 180 Hz` in 12 ms) for clear bass attack alignment
   */
  public scheduleKick(ctx: AudioContext, timeSec: number, level = 0.55): void {
    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = 'sine';
    bodyOsc.frequency.setValueAtTime(140, timeSec);
    bodyOsc.frequency.exponentialRampToValueAtTime(46, timeSec + 0.065);

    bodyGain.gain.setValueAtTime(level, timeSec);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, timeSec + 0.16);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(ctx.destination);
    bodyOsc.start(timeSec);
    bodyOsc.stop(timeSec + 0.17);

    // Beater click transient
    const clickOsc = ctx.createOscillator();
    const clickGain = ctx.createGain();
    clickOsc.type = 'triangle';
    clickOsc.frequency.setValueAtTime(920, timeSec);
    clickOsc.frequency.exponentialRampToValueAtTime(180, timeSec + 0.012);

    clickGain.gain.setValueAtTime(level * 0.35, timeSec);
    clickGain.gain.exponentialRampToValueAtTime(0.001, timeSec + 0.014);

    clickOsc.connect(clickGain);
    clickGain.connect(ctx.destination);
    clickOsc.start(timeSec);
    clickOsc.stop(timeSec + 0.016);
  }

  /**
   * Schedules a crisp studio snare backbeat at `timeSec`:
   * - Shell body triangle oscillator (`185 Hz -> 108 Hz`)
   * - High-passed snare wire noise burst (`1.1 kHz` highpass, 110 ms decay)
   */
  public scheduleSnare(ctx: AudioContext, timeSec: number, level = 0.38): void {
    const bodyOsc = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(185, timeSec);
    bodyOsc.frequency.exponentialRampToValueAtTime(108, timeSec + 0.045);

    bodyGain.gain.setValueAtTime(level * 0.65, timeSec);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, timeSec + 0.075);

    bodyOsc.connect(bodyGain);
    bodyGain.connect(ctx.destination);
    bodyOsc.start(timeSec);
    bodyOsc.stop(timeSec + 0.08);

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.getNoiseBuffer(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1100, timeSec);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(level * 0.75, timeSec);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, timeSec + 0.115);

    noiseSrc.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noiseSrc.start(timeSec);
    noiseSrc.stop(timeSec + 0.12);
  }

  /**
   * Schedules a closed studio hi-hat tick at `timeSec` (`7 kHz` high-passed metallic burst).
   */
  public scheduleHiHat(
    ctx: AudioContext,
    timeSec: number,
    level = 0.16,
  ): void {
    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = this.getNoiseBuffer(ctx);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(7000, timeSec);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, timeSec);
    gain.gain.exponentialRampToValueAtTime(0.0008, timeSec + 0.032);

    noiseSrc.connect(hp);
    hp.connect(gain);
    gain.connect(ctx.destination);
    noiseSrc.start(timeSec);
    noiseSrc.stop(timeSec + 0.036);
  }
}
