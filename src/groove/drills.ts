import type {
  BassGuideMode,
  ClickPlacementMode,
  GroovePatternId,
  PocketFeelOffsetMs,
  SoundEngineMode,
  SpeedTrainerStep,
} from './patterns';
import type { Rhythm } from './rhythm';
import {
  aggregateByStep,
  type RoundHit,
  type RoundSummary,
  standardDeviation,
} from './scoring';
import type { RoundLengthBars } from './storage';
import type { DrillMode, GapClickMode, Subdivision } from './timeline';

/**
 * The Coach's pure logic: picks one targeted drill for what went wrong in a round, builds the
 * drill's level ladder (each level changes one knob, starting easier than what the player just
 * played), judges drill rounds, and moves through levels with a 2-up / 2-down staircase.
 *
 * A drill is just a sequence of practice settings plus a goal, so it runs on the existing engine.
 */

export type DrillId = 'steady-quarters' | 'lay-it-back' | 'on-top' | 'spot-fix' | 'ghost-drummer';

/** The subset of practice settings a drill controls. */
export interface DrillSettings {
  bpm: number;
  groovePattern: GroovePatternId;
  /** Overrides `groovePattern` when set. */
  customRhythm: Rhythm | null;
  subdivision: Subdivision;
  clickPlacement: ClickPlacementMode;
  gapBars: GapClickMode;
  pocketCenterMs: PocketFeelOffsetMs;
  pocketWindowMs: number;
  soundMode: SoundEngineMode;
  bassGuideMode: BassGuideMode;
  roundBars: RoundLengthBars;
  drillMode: DrillMode;
  speedTrainerStep: SpeedTrainerStep;
}

export const DRILL_SETTING_KEYS: readonly (keyof DrillSettings)[] = [
  'bpm',
  'groovePattern',
  'customRhythm',
  'subdivision',
  'clickPlacement',
  'gapBars',
  'pocketCenterMs',
  'pocketWindowMs',
  'soundMode',
  'bassGuideMode',
  'roundBars',
  'drillMode',
  'speedTrainerStep',
];

/** A step position the drill concentrates on (e.g. the rushed "2-&"). */
export interface FocusStep {
  readonly key: string;
  readonly name: string;
}

export interface DrillRecommendation {
  readonly drillId: DrillId;
  /** One sentence: what went wrong and what the drill will do about it. */
  readonly reason: string;
  readonly focusStep: FocusStep | null;
}

export interface DrillLevel {
  /** Short description of what this level asks for (e.g. "80 BPM · ±16 ms"). */
  readonly label: string;
  readonly settings: DrillSettings;
}

export interface DrillPlan {
  readonly drillId: DrillId;
  readonly title: string;
  readonly goal: string;
  readonly focusStep: FocusStep | null;
  readonly levels: readonly DrillLevel[];
}

export const DRILL_TITLES: Readonly<Record<DrillId, string>> = {
  'steady-quarters': 'Steady Quarters',
  'lay-it-back': 'Lay It Back',
  'on-top': 'On Top',
  'spot-fix': 'Spot Fix',
  'ghost-drummer': 'Ghost Drummer',
};

const MIN_BPM = 50;
const MAX_BPM = 200;
const DRILL_ROUND_BARS: RoundLengthBars = 4;
const MIN_HITS_FOR_BIAS = 8;
const MIN_HITS_PER_FOCUS_STEP = 3;
const MIN_HITS_PER_CLICK_GROUP = 6;
const MISSED_NOTES_RATIO = 0.75;

function clampBpm(bpm: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

function mean(values: readonly number[]): number {
  return values.reduce((a, v) => a + v, 0) / values.length;
}

function pocketRate(hits: readonly RoundHit[]): number {
  return hits.filter((h) => h.inPocket && h.noteMatched).length / Math.max(1, hits.length);
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/**
 * Picks the single most useful drill for the evidence (one or more recent rounds of the same
 * groove), or `null` if nothing was played or there is nothing new to offer.
 * Priority: missed notes → click dependence → one trouble step → overall bias → unsteadiness →
 * (all good) a challenge, skipped when that challenge is already mastered.
 *
 * @param summary Summary of `hits` (all evidence rounds combined).
 * @param opts.mastered Drills the player has mastered; only affects the optional challenge.
 */
export function recommendDrill(
  summary: RoundSummary,
  hits: readonly RoundHit[],
  opts: { pocketWindowMs: number; expectedTargetCount: number; mastered?: ReadonlySet<DrillId> },
): DrillRecommendation | null {
  const w = opts.pocketWindowMs;
  if (hits.length === 0 || summary.meanFeelDeltaMs === null) {
    return null;
  }

  if (opts.expectedTargetCount > 0 && hits.length < opts.expectedTargetCount * MISSED_NOTES_RATIO) {
    const missed = opts.expectedTargetCount - hits.length;
    return {
      drillId: 'spot-fix',
      focusStep: null,
      reason: `You missed ${missed} of ${opts.expectedTargetCount} notes. Let's slow the groove down until every note lands, then build the tempo back up.`,
    };
  }

  const silent = hits.filter((h) => h.inSilentBar);
  const withClick = hits.filter((h) => !h.inSilentBar);
  if (silent.length >= MIN_HITS_PER_CLICK_GROUP && withClick.length >= MIN_HITS_PER_CLICK_GROUP) {
    const sigmaSilent = standardDeviation(silent.map((h) => h.feelDeltaMs));
    const sigmaClick = standardDeviation(withClick.map((h) => h.feelDeltaMs));
    if (sigmaSilent > sigmaClick + 0.4 * w || pocketRate(silent) < pocketRate(withClick) - 0.25) {
      return {
        drillId: 'ghost-drummer',
        focusStep: null,
        reason: `Your timing loosens when the click goes silent (spread ${sigmaSilent.toFixed(0)} ms vs ${sigmaClick.toFixed(0)} ms with the click). Let's build your inner clock, one silent bar at a time.`,
      };
    }
  }

  const overall = summary.meanFeelDeltaMs;
  let worst: (FocusStep & { meanMs: number }) | null = null;
  for (const [key, agg] of aggregateByStep(hits)) {
    if (agg.count < MIN_HITS_PER_FOCUS_STEP) continue;
    if (!worst || Math.abs(agg.meanFeelDeltaMs) > Math.abs(worst.meanMs)) {
      worst = { key, name: agg.stepName, meanMs: agg.meanFeelDeltaMs };
    }
  }
  if (worst && Math.abs(worst.meanMs) > 0.5 * w && Math.abs(worst.meanMs - overall) > 0.4 * w) {
    const verb = worst.meanMs < 0 ? 'rush' : 'drag';
    return {
      drillId: 'spot-fix',
      focusStep: { key: worst.key, name: worst.name },
      reason: `You ${verb} the ${worst.name} by ${Math.round(Math.abs(worst.meanMs))} ms on average. Let's nail it at a slower tempo first, then bring it back up to speed.`,
    };
  }

  if (hits.length >= MIN_HITS_FOR_BIAS && Math.abs(overall) > 0.5 * w) {
    const ms = Math.round(Math.abs(overall));
    const latencyHint =
      summary.sigmaMs !== null && summary.sigmaMs < 0.2 * w
        ? ' Every note is off by almost exactly the same amount. If that feels wrong, re-check latency in Setup.'
        : '';
    return overall < 0
      ? {
          drillId: 'lay-it-back',
          focusStep: null,
          reason: `You're rushing: ${ms} ms ahead of the beat on average. Let's practice sitting behind it on purpose.${latencyHint}`,
        }
      : {
          drillId: 'on-top',
          focusStep: null,
          reason: `You're dragging: ${ms} ms behind the beat on average. Let's practice playing on top of it on purpose.${latencyHint}`,
        };
  }

  if (summary.sigmaMs !== null && summary.sigmaMs > 0.75 * w) {
    return {
      drillId: 'steady-quarters',
      focusStep: null,
      reason: `Centered, but uneven (spread ${summary.sigmaMs.toFixed(0)} ms). Let's strip it back to plain quarter notes and make every note land the same.`,
    };
  }

  if (opts.mastered?.has('ghost-drummer')) {
    return null;
  }
  return {
    drillId: 'ghost-drummer',
    focusStep: null,
    reason: 'Solid round! Ready for a challenge? Let\'s take the click away bit by bit and see if your groove holds.',
  };
}

// ---------------------------------------------------------------------------
// Level ladders
// ---------------------------------------------------------------------------

const CLICK_LABELS: Readonly<Record<ClickPlacementMode, string>> = {
  all: 'click every beat',
  'backbeat-2-4': 'click on 2 & 4',
  'one-drop-1': 'click on 1',
  'offbeat-and': 'click on the &s',
};

const GAP_LABELS: Readonly<Record<GapClickMode, string>> = {
  0: '',
  1: '3 on · 1 silent',
  2: '2 on · 2 silent',
};

function levelLabel(s: DrillSettings, includeClick: boolean): string {
  const parts = [`${s.bpm} BPM`, `±${s.pocketWindowMs} ms`];
  if (includeClick) {
    parts.push(CLICK_LABELS[s.clickPlacement]);
    if (s.gapBars !== 0) parts.push(GAP_LABELS[s.gapBars]);
  }
  return parts.join(' · ');
}

/**
 * Builds the level ladder for a drill. Level 1 is deliberately easier than what the player just
 * played (slower, wider tolerance) so the first round is a likely win.
 *
 * @param base The settings the player was practicing with.
 * @param focusStep Optional step to concentrate on (Spot Fix).
 */
export function buildDrillPlan(
  drillId: DrillId,
  base: DrillSettings,
  focusStep: FocusStep | null,
): DrillPlan {
  const start = clampBpm(base.bpm * 0.8);
  const mid = clampBpm((start + base.bpm) / 2);
  const target = clampBpm(base.bpm);
  const beyond = clampBpm(base.bpm + 8);

  const common: DrillSettings = {
    ...base,
    bassGuideMode: 'off',
    speedTrainerStep: 0,
    roundBars: DRILL_ROUND_BARS,
  };

  const make = (
    overrides: Partial<DrillSettings>,
    steps: ReadonlyArray<readonly [number, number, Partial<DrillSettings>?]>,
    includeClick = false,
  ): DrillLevel[] =>
    steps.map(([bpm, windowMs, extra]) => {
      const settings: DrillSettings = {
        ...common,
        ...overrides,
        ...extra,
        bpm,
        pocketWindowMs: windowMs,
      };
      return { settings, label: levelLabel(settings, includeClick) };
    });

  const tempoLadder: ReadonlyArray<readonly [number, number]> = [
    [start, 25],
    [start, 16],
    [mid, 16],
    [target, 16],
    [target, 10],
    [beyond, 10],
  ];

  switch (drillId) {
    case 'steady-quarters':
      return {
        drillId,
        title: DRILL_TITLES[drillId],
        goal: 'Plain quarter notes. Make every note land the same.',
        focusStep: null,
        levels: make(
          { groovePattern: 'uniform', customRhythm: null, subdivision: 1, clickPlacement: 'all', gapBars: 0, pocketCenterMs: 0, drillMode: 'free' },
          tempoLadder,
        ),
      };
    case 'lay-it-back':
      return {
        drillId,
        title: DRILL_TITLES[drillId],
        goal: 'Sit just behind the beat (+12 ms). Let the drums come to you.',
        focusStep: null,
        levels: make({ pocketCenterMs: 12, clickPlacement: 'all', gapBars: 0, soundMode: 'drums' }, tempoLadder),
      };
    case 'on-top':
      return {
        drillId,
        title: DRILL_TITLES[drillId],
        goal: 'Push just ahead of the beat (−8 ms). Drive the groove.',
        focusStep: null,
        levels: make({ pocketCenterMs: -8, clickPlacement: 'all', gapBars: 0, soundMode: 'drums' }, tempoLadder),
      };
    case 'spot-fix':
      return {
        drillId,
        title: DRILL_TITLES[drillId],
        goal: focusStep
          ? `Nail the ${focusStep.name}. Slower first, then back up to tempo.`
          : 'Same groove, slower. Land every note, then build the tempo back up.',
        focusStep,
        levels: make({ clickPlacement: 'all', gapBars: 0 }, [
          [start, 25],
          [start, 16],
          [mid, 16],
          [target, 16],
          [beyond, 16],
        ]),
      };
    case 'ghost-drummer':
      return {
        drillId,
        title: DRILL_TITLES[drillId],
        goal: 'The click drops out. Keep the groove going on your own.',
        focusStep: null,
        levels: make(
          {},
          [
            [start, 25, { clickPlacement: 'all', gapBars: 1 }],
            [start, 16, { clickPlacement: 'all', gapBars: 1 }],
            [start, 16, { clickPlacement: 'all', gapBars: 2 }],
            [mid, 16, { clickPlacement: 'backbeat-2-4', gapBars: 0 }],
            [mid, 16, { clickPlacement: 'backbeat-2-4', gapBars: 1 }],
            [target, 16, { clickPlacement: 'one-drop-1', gapBars: 1 }],
            [target, 16, { clickPlacement: 'one-drop-1', gapBars: 2 }],
          ],
          true,
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Judging & staircase
// ---------------------------------------------------------------------------

export type DrillVerdict = 'pass' | 'neutral' | 'fail';

/**
 * Pass = ≥ 80% in the pocket, spread ≤ 0.75·w, and (if set) the focus step averages within
 * 0.5·w. Fail = < 60% in the pocket. Anything else is neutral.
 */
export function judgeDrillRound(
  summary: RoundSummary,
  hits: readonly RoundHit[],
  opts: { pocketWindowMs: number; focusStepKey: string | null },
): DrillVerdict {
  const w = opts.pocketWindowMs;
  if (summary.inPocketPct < 60) {
    return 'fail';
  }
  let focusOk = true;
  if (opts.focusStepKey) {
    const focus = hits.filter((h) => h.stepKey === opts.focusStepKey);
    if (focus.length >= 2) {
      focusOk = Math.abs(mean(focus.map((h) => h.feelDeltaMs))) <= 0.5 * w;
    }
  }
  const steady = summary.sigmaMs !== null && summary.sigmaMs <= 0.75 * w;
  return summary.inPocketPct >= 80 && steady && focusOk ? 'pass' : 'neutral';
}

export interface StaircaseState {
  readonly level: number;
  readonly passStreak: number;
  readonly failStreak: number;
}

export type StaircaseEvent = 'hold' | 'level-up' | 'level-down' | 'complete';

export function startStaircase(level = 0): StaircaseState {
  return { level, passStreak: 0, failStreak: 0 };
}

const STREAK_TO_MOVE = 2;

/**
 * 2 passes in a row → next level (or `'complete'` on the top level); 2 fails in a row → previous
 * level (never below the first). A neutral round resets both streaks.
 */
export function advanceStaircase(
  state: StaircaseState,
  verdict: DrillVerdict,
  levelCount: number,
): { state: StaircaseState; event: StaircaseEvent } {
  if (verdict === 'neutral') {
    return { state: { level: state.level, passStreak: 0, failStreak: 0 }, event: 'hold' };
  }
  if (verdict === 'pass') {
    const passStreak = state.passStreak + 1;
    if (passStreak < STREAK_TO_MOVE) {
      return { state: { level: state.level, passStreak, failStreak: 0 }, event: 'hold' };
    }
    if (state.level >= levelCount - 1) {
      return { state: startStaircase(state.level), event: 'complete' };
    }
    return { state: startStaircase(state.level + 1), event: 'level-up' };
  }
  const failStreak = state.failStreak + 1;
  if (failStreak < STREAK_TO_MOVE) {
    return { state: { level: state.level, passStreak: 0, failStreak }, event: 'hold' };
  }
  if (state.level === 0) {
    return { state: startStaircase(0), event: 'hold' };
  }
  return { state: startStaircase(state.level - 1), event: 'level-down' };
}

// ---------------------------------------------------------------------------
// Progress metric
// ---------------------------------------------------------------------------

export interface FocusMeasurement {
  readonly label: string;
  readonly value: number | null;
  readonly unit: '%' | 'ms';
}

/**
 * The one number each drill is trying to improve, used for "before → now" comparisons.
 */
export function measureFocus(plan: DrillPlan, hits: readonly RoundHit[]): FocusMeasurement {
  const round1 = (v: number): number => Math.round(v * 10) / 10;
  switch (plan.drillId) {
    case 'spot-fix': {
      if (plan.focusStep) {
        const focus = hits.filter((h) => h.stepKey === plan.focusStep?.key);
        return {
          label: `Your ${plan.focusStep.name}`,
          value: focus.length > 0 ? round1(mean(focus.map((h) => h.feelDeltaMs))) : null,
          unit: 'ms',
        };
      }
      return {
        label: 'Notes in the pocket',
        value: hits.length > 0 ? Math.round(pocketRate(hits) * 100) : null,
        unit: '%',
      };
    }
    case 'lay-it-back':
    case 'on-top':
      return {
        label: 'Average timing vs. the grid',
        value: hits.length > 0 ? round1(mean(hits.map((h) => h.offsetMs))) : null,
        unit: 'ms',
      };
    case 'steady-quarters':
      return {
        label: 'Spread',
        value: hits.length >= 2 ? round1(standardDeviation(hits.map((h) => h.feelDeltaMs))) : null,
        unit: 'ms',
      };
    case 'ghost-drummer': {
      const silent = hits.filter((h) => h.inSilentBar);
      const pool = silent.length >= 2 ? silent : hits;
      return {
        label: silent.length >= 2 ? 'Spread in silent bars' : 'Spread',
        value: pool.length >= 2 ? round1(standardDeviation(pool.map((h) => h.feelDeltaMs))) : null,
        unit: 'ms',
      };
    }
  }
}
