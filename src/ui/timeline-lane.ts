import type { BarScheduleInfo } from '../audio/audio-engine';
import type { PatternStepDescriptor } from '../groove/patterns';
import type { HitJudgment } from '../groove/scoring';
import type { VisualGuideMode } from '../groove/storage';
import {
  FONTS,
  fitCanvas,
  judgmentColor,
  PALETTE,
  roundRectPath,
  withAlpha,
} from './canvas-kit';

/** How a scheduled bar should be presented. */
export type LanePhase = 'count-in' | 'play' | 'listen' | 'silent';


interface LaneBar {
  readonly info: BarScheduleInfo;
  readonly phase: LanePhase;
}

interface Flash {
  readonly color: string;
  readonly startMs: number;
}

/** The most recent graded hit on a step. */
interface LastHit {
  readonly feelDeltaMs: number;
  readonly judgment: HitJudgment;
  readonly atMs: number;
}

const FLASH_DURATION_MS = 320;
const MAX_QUEUED_BARS = 6;
/** A hit older than this many bars (while playing) is drawn dimmed: that note was missed since. */
const STALE_AFTER_BARS = 1.05;

/**
 * Real-time canvas view of one bar: note blocks sized by duration with note names, how early /
 * late / on time your most recent hit on each note was (signed ms + word + tint), hit flashes,
 * count-in digits, LISTEN / SILENT overlays, and an optional position guide synced to the audio
 * clock. This is the fixed-bar first incarnation of the scrolling note highway.
 *
 * Data flow: the controller pushes bar schedules (`pushBar`) and graded hits (`recordHit`); the
 * lane redraws itself every animation frame, reading the audio clock.
 */
export class TimelineLane {
  private readonly canvas: HTMLCanvasElement;
  private readonly readClock: () => number | null;

  private steps: readonly PatternStepDescriptor[] = [];
  private noteLabels: readonly string[] = [];
  private lastHits: (LastHit | null)[] = [];
  private flashes = new Map<number, Flash>();
  private bars: LaneBar[] = [];
  private pocketWindowMs = 16;
  private guide: VisualGuideMode = 'glow';
  private focusStepIndex: number | null = null;
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement, readClock: () => number | null) {
    this.canvas = canvas;
    this.readClock = readClock;
  }

  /** Starts the animation loop. */
  public start(): void {
    if (this.rafId !== null) {
      return;
    }
    const frame = (): void => {
      this.draw();
      this.rafId = window.requestAnimationFrame(frame);
    };
    this.rafId = window.requestAnimationFrame(frame);
  }

  /**
   * Replaces the bar layout. Last hits are cleared when the step grid changes.
   *
   * @param steps Steps of one bar.
   * @param noteLabels Note name per step (empty string for none).
   */
  public setSteps(
    steps: readonly PatternStepDescriptor[],
    noteLabels: readonly string[],
  ): void {
    const signature = (s: readonly PatternStepDescriptor[]): string =>
      s.map((x) => `${x.durationBeats}:${x.isTargetActive ? 1 : 0}`).join('|');
    if (signature(steps) !== signature(this.steps)) {
      this.lastHits = steps.map(() => null);
      this.flashes.clear();
    }
    this.steps = steps;
    this.noteLabels = noteLabels;
  }

  public setNoteLabels(noteLabels: readonly string[]): void {
    this.noteLabels = noteLabels;
  }

  public setPocketWindow(pocketWindowMs: number): void {
    this.pocketWindowMs = pocketWindowMs;
  }

  public setGuide(guide: VisualGuideMode): void {
    this.guide = guide;
  }

  /** Marks one step as the drill's focus (outlined and tagged), or clears it with `null`. */
  public setFocusStep(stepIndex: number | null): void {
    this.focusStepIndex = stepIndex;
  }

  /** Queues a scheduled bar; the lane shows whichever bar is currently sounding. */
  public pushBar(info: BarScheduleInfo, phase: LanePhase): void {
    this.bars.push({ info, phase });
    if (this.bars.length > MAX_QUEUED_BARS) {
      this.bars.shift();
    }
  }

  public clearBars(): void {
    this.bars = [];
  }

  /**
   * Shows a graded hit on its step (replacing the previous one) and flashes the block.
   *
   * @param feelDeltaMs Signed offset from the feel target (negative = early).
   */
  public recordHit(stepIndex: number, feelDeltaMs: number, judgment: HitJudgment): void {
    if (stepIndex < 0 || stepIndex >= this.steps.length) {
      return;
    }
    const now = performance.now();
    this.lastHits[stepIndex] = { feelDeltaMs, judgment, atMs: now };
    this.flashes.set(stepIndex, { color: judgmentColor(judgment), startMs: now });
  }

  public resetHits(): void {
    this.lastHits = this.steps.map(() => null);
    this.flashes.clear();
  }

  private currentBar(nowSec: number | null): { bar: LaneBar; progress: number } | null {
    if (nowSec === null) {
      return null;
    }
    for (let i = this.bars.length - 1; i >= 0; i--) {
      const bar = this.bars[i];
      if (bar.info.startTimeSec <= nowSec) {
        const progress = (nowSec - bar.info.startTimeSec) / bar.info.durationSec;
        return progress <= 1.0 ? { bar, progress } : null;
      }
    }
    return null;
  }

  private draw(): void {
    const fitted = fitCanvas(this.canvas);
    if (!fitted) {
      return;
    }
    const { ctx, width, height } = fitted;
    const padX = 16;
    const headerH = 30;
    const innerW = width - padX * 2;
    const blockTop = headerH + 4;
    const blockH = Math.max(40, height - 12 - blockTop);
    const totalBeats = this.steps.reduce((acc, s) => acc + s.durationBeats, 0) || 4;
    const xAtBeat = (beat: number): number => padX + (beat / totalBeats) * innerW;

    const current = this.currentBar(this.readClock());
    const glowBeat =
      current && current.bar.phase !== 'count-in' && this.guide === 'glow'
        ? Math.min(Math.floor(totalBeats) - 1, Math.floor(current.progress * totalBeats))
        : null;

    for (let beat = 0; beat < Math.round(totalBeats); beat++) {
      const x0 = xAtBeat(beat);
      const x1 = xAtBeat(beat + 1);
      if (beat === glowBeat) {
        ctx.fillStyle = withAlpha(PALETTE.amber, 0.09);
        ctx.fillRect(x0, 0, x1 - x0, height);
      } else if (beat % 2 === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fillRect(x0, 0, x1 - x0, height);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, 0);
      ctx.lineTo(Math.round(x0) + 0.5, height);
      ctx.stroke();
    }

    const now = performance.now();
    let cumBeats = 0;
    this.steps.forEach((step, idx) => {
      const x0 = xAtBeat(cumBeats);
      const x1 = xAtBeat(cumBeats + step.durationBeats);
      cumBeats += step.durationBeats;
      this.drawStepHeader(ctx, step, x0, headerH, step.beatInBar === glowBeat);
      this.drawStepBlock(ctx, step, idx, x0, x1, blockTop, blockH, now);
    });

    if (current) {
      this.drawPhaseOverlay(ctx, current.bar, width, height, xAtBeat, totalBeats, current.progress);
      if (this.guide === 'sweep' && current.bar.phase !== 'count-in') {
        const x = padX + current.progress * innerW;
        ctx.fillStyle = withAlpha(PALETTE.textPrimary, 0.85);
        ctx.fillRect(x - 1, 0, 2, height);
      }
    }
  }

  private drawStepHeader(
    ctx: CanvasRenderingContext2D,
    step: PatternStepDescriptor,
    x0: number,
    headerH: number,
    isGlowing: boolean,
  ): void {
    const isBeat = step.subIndex === 0;
    ctx.fillStyle = isBeat
      ? isGlowing
        ? PALETTE.amber
        : PALETTE.textPrimary
      : PALETTE.textMuted;
    ctx.font = `${isBeat ? 700 : 500} ${isBeat ? 18 : 13}px ${FONTS.mono}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(step.shortStepLabel, x0 + 6, headerH / 2 + 2);
  }

  private drawStepBlock(
    ctx: CanvasRenderingContext2D,
    step: PatternStepDescriptor,
    idx: number,
    x0: number,
    x1: number,
    top: number,
    height: number,
    nowMs: number,
  ): void {
    const inset = 3;
    const bx = x0 + inset;
    const bw = Math.max(4, x1 - x0 - inset * 2);

    if (!step.isTargetActive) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      roundRectPath(ctx, bx + 0.5, top + 0.5, bw - 1, height - 1, 8);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }

    const hit = this.lastHits[idx] ?? null;
    const timing = hit ? this.classify(hit) : null;
    // While playing, a hit older than about one bar means this note was missed since: dim it.
    const barMs = this.currentBarDurationMs();
    const fresh = hit !== null && (barMs === null || nowMs - hit.atMs <= barMs * STALE_AFTER_BARS);
    const fade = fresh ? 1 : 0.35;
    let fill = withAlpha(PALETTE.amber, 0.1);
    let stroke = withAlpha(PALETTE.amber, 0.55);
    if (hit && timing) {
      const strength = Math.min(1, Math.abs(hit.feelDeltaMs) / (this.pocketWindowMs * 1.5));
      const base = timing === 'on' ? judgmentColor(hit.judgment) : timing === 'early' ? PALETTE.rush : PALETTE.drag;
      fill = withAlpha(base, (timing === 'on' ? 0.16 : 0.1 + strength * 0.22) * fade);
      stroke = withAlpha(base, (timing === 'on' ? 0.75 : 0.55 + strength * 0.4) * Math.max(fade, 0.5));
    }

    roundRectPath(ctx, bx, top, bw, height, 8);
    ctx.fillStyle = fill;
    ctx.fill();

    const flash = this.flashes.get(idx);
    if (flash) {
      const t = (nowMs - flash.startMs) / FLASH_DURATION_MS;
      if (t < 1) {
        ctx.fillStyle = withAlpha(flash.color, 0.45 * (1 - t));
        ctx.fill();
      } else {
        this.flashes.delete(idx);
      }
    }

    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (idx === this.focusStepIndex) {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = PALETTE.textPrimary;
      ctx.lineWidth = 2;
      roundRectPath(ctx, bx - 2, top - 2, bw + 4, height + 4, 10);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `700 11px ${FONTS.sans}`;
      ctx.fillStyle = PALETTE.textPrimary;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('FOCUS', bx + bw / 2, top + 8);
    }

    const label = this.noteLabels[idx] ?? '';
    const cx = bx + bw / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (label && bw >= 26) {
      ctx.fillStyle = PALETTE.textPrimary;
      const size = Math.min(26, Math.max(12, bw / 3.2), height / 4);
      ctx.font = `700 ${size}px ${FONTS.mono}`;
      ctx.fillText(label, cx, top + height * (timing ? 0.36 : 0.5));
    }

    if (hit && timing) {
      // How this note just landed: a signed number (same convention as the "Last note" readout,
      // negative = early) plus a plain word.
      const color =
        timing === 'on' ? judgmentColor(hit.judgment) : timing === 'early' ? PALETTE.rush : PALETTE.drag;
      const word = timing === 'on' ? 'ON TIME' : timing === 'early' ? 'EARLY' : 'LATE';
      const ms = Math.round(Math.abs(hit.feelDeltaMs));
      const sign = ms === 0 ? '±' : hit.feelDeltaMs < 0 ? '−' : '+';
      const main = `${sign}${ms}${bw >= 92 ? ' ms' : ''}`;

      const centerY = top + height * (label ? 0.64 : 0.5);
      const mainSize = Math.min(24, Math.max(12, bw / 4), height / 5);
      const wordSize = Math.min(13, Math.max(9, bw / 7));
      ctx.globalAlpha = fade;
      ctx.fillStyle = color;
      ctx.font = `700 ${mainSize}px ${FONTS.mono}`;
      ctx.fillText(main, cx, centerY - wordSize * 0.6);
      ctx.font = `700 ${wordSize}px ${FONTS.sans}`;
      ctx.fillText(word, cx, centerY + mainSize * 0.55 + 2);
      ctx.globalAlpha = 1;
    }
  }

  /** On time = inside the pocket window (same rule as the grader). */
  private classify(hit: LastHit): 'on' | 'early' | 'late' {
    if (hit.judgment === 'locked' || hit.judgment === 'pocket') {
      return 'on';
    }
    return hit.feelDeltaMs < 0 ? 'early' : 'late';
  }

  /** Duration of the most recently scheduled bar, or `null` when not playing. */
  private currentBarDurationMs(): number | null {
    const last = this.bars[this.bars.length - 1];
    return last ? last.info.durationSec * 1000 : null;
  }

  private drawPhaseOverlay(
    ctx: CanvasRenderingContext2D,
    bar: LaneBar,
    width: number,
    height: number,
    xAtBeat: (beat: number) => number,
    totalBeats: number,
    progress: number,
  ): void {
    if (bar.phase === 'count-in') {
      ctx.fillStyle = 'rgba(10, 8, 7, 0.78)';
      ctx.fillRect(0, 0, width, height);
      const currentBeat = Math.min(3, Math.floor(progress * 4));
      for (let beat = 0; beat < 4; beat++) {
        const x0 = xAtBeat((beat / 4) * totalBeats);
        const x1 = xAtBeat(((beat + 1) / 4) * totalBeats);
        const isNow = beat === currentBeat;
        ctx.fillStyle = isNow
          ? PALETTE.amber
          : withAlpha(PALETTE.textMuted, beat < currentBeat ? 0.5 : 0.25);
        ctx.font = `700 ${Math.min(96, height * 0.55)}px ${FONTS.display}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(beat + 1), (x0 + x1) / 2, height / 2 + 4);
      }
      return;
    }

    if (bar.phase === 'silent') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      ctx.strokeStyle = withAlpha(PALETTE.silent, 0.1);
      ctx.lineWidth = 10;
      for (let x = -height; x < width; x += 28) {
        ctx.beginPath();
        ctx.moveTo(x, height);
        ctx.lineTo(x + height, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (bar.phase === 'listen') {
      ctx.fillStyle = 'rgba(10, 8, 7, 0.45)';
      ctx.fillRect(0, 0, width, height);
    }

    const banner =
      bar.phase === 'silent'
        ? 'SILENT · KEEP IT GOING'
        : bar.phase === 'listen'
          ? 'LISTEN'
          : null;
    if (banner) {
      const color = bar.phase === 'silent' ? PALETTE.silent : PALETTE.drag;
      ctx.font = `700 15px ${FONTS.display}`;
      const bwid = ctx.measureText(banner).width + 28;
      const bh = 28;
      const by = height / 2 - bh / 2;
      roundRectPath(ctx, width / 2 - bwid / 2, by, bwid, bh, 14);
      ctx.fillStyle = 'rgba(10, 8, 7, 0.9)';
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(banner, width / 2, by + bh / 2 + 0.5);
    }
  }
}
