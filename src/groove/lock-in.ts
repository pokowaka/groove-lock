import type { ReleaseJudgment } from './release-grading';

/**
 * Lock-in: keep playing until you nail it. The groove never stops for a results card; instead it
 * runs until you play `goal` clean bars in a row (or too many bars pass without that). Strict on
 * purpose: a clean bar has every note in the pocket, on the right pitch, nothing extra, and (when
 * lengths are graded) every note ending on time.
 */

export interface BarEvidence {
  /** Graded targets in the bar. */
  readonly expected: number;
  readonly hits: readonly { readonly inPocket: boolean; readonly noteMatched: boolean }[];
  /** Plucks that matched no target (played in the wrong place). */
  readonly strays: number;
  /** Judgments of the graded note lengths heard in this bar. */
  readonly lengths: readonly ReleaseJudgment[];
}

export function isCleanBar(e: BarEvidence): boolean {
  return (
    e.expected > 0 &&
    e.hits.length === e.expected &&
    e.hits.every((h) => h.inPocket && h.noteMatched) &&
    e.strays === 0 &&
    e.lengths.every((l) => l === 'on-time')
  );
}

/** Clean bars in a row needed at a drill level: 2, then 4, then 8 as the levels rise. */
export function goalBarsForLevel(level: number, levelCount: number): number {
  const progress = levelCount > 1 ? level / levelCount : 0;
  return progress < 1 / 3 ? 2 : progress < 2 / 3 ? 4 : 8;
}

/** Bars allowed before the attempt stops for a breather. */
export function maxBarsForGoal(goal: number): number {
  return goal * 3 + 8;
}

export type LockInEvent = 'clean' | 'miss' | 'nailed' | 'gave-up';

/** A run of bars, by bar number (inclusive). */
export interface BarRange {
  readonly from: number;
  readonly to: number;
}

export class LockInTracker {
  public streak = 0;
  public best = 0;
  private judged: number[] = [];
  private result: 'nailed' | 'gave-up' | null = null;
  private nailed: BarRange | null = null;

  constructor(
    public readonly goal: number,
    public readonly maxBars: number,
  ) {}

  /** Records the verdict of the next judged bar. */
  public record(barNumber: number, clean: boolean): LockInEvent {
    if (this.result) {
      return this.result;
    }
    this.judged.push(barNumber);
    this.streak = clean ? this.streak + 1 : 0;
    this.best = Math.max(this.best, this.streak);
    if (this.streak >= this.goal) {
      this.result = 'nailed';
      this.nailed = { from: barNumber - this.goal + 1, to: barNumber };
      return 'nailed';
    }
    if (this.judged.length >= this.maxBars) {
      this.result = 'gave-up';
      return 'gave-up';
    }
    return clean ? 'clean' : 'miss';
  }

  public get isFinished(): boolean {
    return this.result !== null;
  }

  public get outcome(): 'nailed' | 'gave-up' | null {
    return this.result;
  }

  /** The bars that nailed it, or `null`. */
  public get nailedBars(): BarRange | null {
    return this.nailed;
  }

  /** The first `goal` judged bars (the "first try"), or `null` before any bar. */
  public get firstBars(): BarRange | null {
    return this.range(this.judged.slice(0, this.goal));
  }

  /** The last `goal` judged bars. */
  public get lastBars(): BarRange | null {
    return this.range(this.judged.slice(-this.goal));
  }

  public get barsJudged(): number {
    return this.judged.length;
  }

  private range(bars: number[]): BarRange | null {
    return bars.length > 0 ? { from: bars[0], to: bars[bars.length - 1] } : null;
  }
}
