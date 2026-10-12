import type { HitJudgment } from '../groove/scoring';

/** Canvas colors mirroring the CSS custom properties in `style.css`. */
export const PALETTE = {
  amber: 'hsl(38, 92%, 56%)',
  locked: 'hsl(146, 80%, 56%)',
  pocket: 'hsl(152, 62%, 45%)',
  rush: 'hsl(14, 85%, 60%)',
  drag: 'hsl(202, 80%, 60%)',
  silent: 'hsl(270, 70%, 75%)',
  textPrimary: 'hsl(36, 18%, 93%)',
  textSecondary: 'hsl(32, 10%, 70%)',
  textMuted: 'hsl(28, 8%, 56%)',
  border: 'hsl(24, 5%, 22%)',
} as const;

/** Canvas fonts mirroring the CSS font stacks. */
export const FONTS = {
  mono: "'JetBrains Mono', ui-monospace, monospace",
  display: "'Space Grotesk', 'Inter', sans-serif",
  sans: "'Inter', -apple-system, sans-serif",
} as const;

/** Maps a judgment to its display color. */
export function judgmentColor(judgment: HitJudgment): string {
  switch (judgment) {
    case 'locked':
      return PALETTE.locked;
    case 'pocket':
      return PALETTE.pocket;
    case 'rushed':
      return PALETTE.rush;
    case 'dragged':
      return PALETTE.drag;
  }
}

/** A canvas 2D context sized to the element's CSS box at device pixel ratio. */
export interface FittedCanvas {
  readonly ctx: CanvasRenderingContext2D;
  /** Width in CSS pixels. */
  readonly width: number;
  /** Height in CSS pixels. */
  readonly height: number;
}

/**
 * Resizes the canvas backing store to its CSS size × devicePixelRatio (only when it changed) and
 * returns a context whose units are CSS pixels.
 */
export function fitCanvas(canvas: HTMLCanvasElement): FittedCanvas | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pxW = Math.max(1, Math.round(width * dpr));
  const pxH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Adds a rounded-rectangle path (no fill/stroke). */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Returns `color` (an `hsl(...)` string) with the given alpha as `hsla(...)`. */
export function withAlpha(color: string, alpha: number): string {
  return color.replace(/^hsl\((.*)\)$/, `hsla($1, ${alpha.toFixed(3)})`);
}
