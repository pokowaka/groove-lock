import type { HitJudgment } from '../groove/scoring';
import {
  FONTS,
  fitCanvas,
  judgmentColor,
  PALETTE,
  roundRectPath,
  withAlpha,
} from './canvas-kit';

/** One hit plotted on the pocket meter. */
export interface MeterHit {
  /** Offset from the grid in ms (negative = early). */
  readonly offsetMs: number;
  readonly judgment: HitJudgment;
}

const RANGE_MS = 60;
const BIN_MS = 3;
const RECENT_HITS = 16;
/** Older hits fade out completely over this time. */
const FADE_MS = 2500;
/** The latest hit stays bright this long, then dims to `LATEST_MIN_ALPHA` until the next hit. */
const LATEST_HOLD_MS = 1500;
const LATEST_MIN_ALPHA = 0.45;

interface TimedHit extends MeterHit {
  readonly atMs: number;
}

/**
 * Canvas pocket meter: a ±60 ms ruler around the grid showing the pocket zone (shifted by the feel
 * target), a faint session histogram of offsets, and recent hits that fade out over a few seconds.
 *
 * Redraws on demand (`render()`), on element resize, and every animation frame while hits are
 * still fading.
 */
export class PocketMeter {
  private readonly canvas: HTMLCanvasElement;
  private pocketCenterMs = 0;
  private pocketWindowMs = 16;
  private recent: TimedHit[] = [];
  private fadeRafId: number | null = null;
  private bins: number[] = new Array<number>(Math.round((RANGE_MS * 2) / BIN_MS)).fill(0);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    new ResizeObserver(() => this.render()).observe(canvas);
  }

  public setPocket(centerMs: number, windowMs: number): void {
    this.pocketCenterMs = centerMs;
    this.pocketWindowMs = windowMs;
    this.render();
  }

  /** Adds a hit to the recent list and the session histogram. */
  public addHit(hit: MeterHit): void {
    this.recent.unshift({ ...hit, atMs: performance.now() });
    if (this.recent.length > RECENT_HITS) {
      this.recent.pop();
    }
    const clamped = Math.max(-RANGE_MS, Math.min(RANGE_MS - 0.001, hit.offsetMs));
    const bin = Math.floor((clamped + RANGE_MS) / BIN_MS);
    this.bins[bin] = (this.bins[bin] ?? 0) + 1;
    this.render();
    this.ensureFading();
  }

  private ensureFading(): void {
    if (this.fadeRafId !== null) {
      return;
    }
    const frame = (): void => {
      this.render();
      const newest = this.recent[0];
      const stillFading =
        newest !== undefined &&
        performance.now() - newest.atMs < Math.max(FADE_MS, LATEST_HOLD_MS + 600);
      this.fadeRafId = stillFading ? window.requestAnimationFrame(frame) : null;
    };
    this.fadeRafId = window.requestAnimationFrame(frame);
  }

  public clear(): void {
    this.recent = [];
    this.bins.fill(0);
    this.render();
  }

  public render(): void {
    const fitted = fitCanvas(this.canvas);
    if (!fitted) {
      return;
    }
    const { ctx, width, height } = fitted;
    const labelH = 18;
    const top = 2;
    const trackH = Math.max(30, height - labelH - top - 2);
    const xAt = (ms: number): number => ((ms + RANGE_MS) / (RANGE_MS * 2)) * width;

    roundRectPath(ctx, 0.5, top + 0.5, width - 1, trackH - 1, 8);
    ctx.fillStyle = 'hsl(24, 8%, 5%)';
    ctx.fill();
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, 0.5, top + 0.5, width - 1, trackH - 1, 8);
    ctx.clip();

    // Histogram
    const maxBin = Math.max(1, ...this.bins);
    const binW = width / this.bins.length;
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    this.bins.forEach((count, i) => {
      if (count === 0) {
        return;
      }
      const h = (count / maxBin) * (trackH - 10);
      ctx.fillRect(i * binW + 1, top + trackH - h, binW - 2, h);
    });

    // Pocket zone
    const z0 = xAt(this.pocketCenterMs - this.pocketWindowMs);
    const z1 = xAt(this.pocketCenterMs + this.pocketWindowMs);
    ctx.fillStyle = withAlpha(PALETTE.pocket, 0.13);
    ctx.fillRect(z0, top, z1 - z0, trackH);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = withAlpha(PALETTE.pocket, 0.5);
    ctx.beginPath();
    ctx.moveTo(z0 + 0.5, top);
    ctx.lineTo(z0 + 0.5, top + trackH);
    ctx.moveTo(z1 - 0.5, top);
    ctx.lineTo(z1 - 0.5, top + trackH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Grid line and feel target
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(xAt(0) - 0.5, top, 1, trackH);
    if (this.pocketCenterMs !== 0) {
      ctx.fillStyle = PALETTE.pocket;
      ctx.fillRect(xAt(this.pocketCenterMs) - 1, top, 2, trackH);
    }

    // Ticks every 10 ms
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let ms = -RANGE_MS + 10; ms < RANGE_MS; ms += 10) {
      const major = ms % 30 === 0;
      ctx.fillRect(xAt(ms) - 0.5, top + trackH - (major ? 10 : 6), 1, major ? 10 : 6);
    }

    // Recent hits, oldest first so the latest draws on top
    const nowMs = performance.now();
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const hit = this.recent[i];
      const isLatest = i === 0;
      const ageMs = nowMs - hit.atMs;
      const alpha = isLatest
        ? ageMs < LATEST_HOLD_MS
          ? 1
          : Math.max(LATEST_MIN_ALPHA, 1 - (ageMs - LATEST_HOLD_MS) / 600)
        : 0.7 * (1 - ageMs / FADE_MS);
      if (alpha <= 0) {
        continue;
      }
      const clamped = Math.max(-RANGE_MS + 2, Math.min(RANGE_MS - 2, hit.offsetMs));
      const x = xAt(clamped);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = judgmentColor(hit.judgment);
      const w = isLatest ? 6 : 3;
      const inset = isLatest ? 4 : 10;
      roundRectPath(ctx, x - w / 2, top + inset, w, trackH - inset * 2, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Scale labels
    ctx.font = `500 11px ${FONTS.mono}`;
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textBaseline = 'top';
    const labelY = top + trackH + 4;
    const labels: ReadonlyArray<readonly [number, string, CanvasTextAlign]> = [
      [-RANGE_MS, '← early −60', 'left'],
      [-30, '−30', 'center'],
      [0, 'grid', 'center'],
      [30, '+30', 'center'],
      [RANGE_MS, '+60 late →', 'right'],
    ];
    for (const [ms, text, align] of labels) {
      ctx.textAlign = align;
      ctx.fillText(text, Math.max(0, Math.min(width, xAt(ms))), labelY);
    }
  }
}
