import { displaceRhythm, groupsRhythm, regridRhythm, spotRhythm, strangeRhythm } from './off-grid';
import {
  type BassGuideMode,
  type ClickPlacementMode,
  type GroovePatternId,
  type PocketFeelOffsetMs,
  rhythmForPattern,
  type SoundEngineMode,
  type SpeedTrainerStep,
} from './patterns';
import { type ReleaseHit, type ReleaseSummary, summarizeReleases } from './release-grading';
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

export type DrillId =
  | 'steady-quarters'
  | 'lay-it-back'
  | 'on-top'
  | 'spot-fix'
  | 'ghost-drummer'
  | 'odd-spot'
  | 'displacement'
  | 'groups-over-4'
  | 'strange-rhythms'
  | 'note-length';

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
  /** What to do, in plain musical words (shown instead of the drill goal when set). */
  readonly hint?: string;
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
  'odd-spot': 'Odd Spot',
  displacement: 'Displacement',
  'groups-over-4': 'Groups Over 4',
  'strange-rhythms': 'Strange Rhythms',
  'note-length': 'Note Length',
};

const MIN_BPM = 50;
const MAX_BPM = 200;
const DRILL_ROUND_BARS: RoundLengthBars = 4;
const MIN_HITS_FOR_BIAS = 8;
const MIN_HITS_PER_FOCUS_STEP = 3;
const MIN_HITS_PER_CLICK_GROUP = 6;
const MISSED_NOTES_RATIO = 0.75;
const MIN_RELEASES_FOR_LENGTH = 8;

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
  opts: {
    pocketWindowMs: number;
    expectedTargetCount: number;
    mastered?: ReadonlySet<DrillId>;
    /** Graded note lengths of the evidence, when the rhythm grades them. */
    releases?: ReleaseSummary;
  },
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

  const rel = opts.releases;
  if (rel && rel.count >= MIN_RELEASES_FOR_LENGTH && rel.onTimePct < 60 && rel.meanDeltaMs !== null) {
    const ms = Math.round(Math.abs(rel.meanDeltaMs));
    return {
      drillId: 'note-length',
      focusStep: null,
      reason:
        rel.meanDeltaMs < 0
          ? `Your timing is fine, but you cut notes short by ${ms} ms on average. Let's practice ending each note right where it's written.`
          : `Your timing is fine, but you let notes ring ${ms} ms too long on average. Let's practice muting each note right where it's written.`,
    };
  }

  if (!opts.mastered?.has('ghost-drummer')) {
    return {
      drillId: 'ghost-drummer',
      focusStep: null,
      reason: 'Solid round! Ready for a challenge? Let\'s take the click away bit by bit and see if your groove holds.',
    };
  }
  if (!opts.mastered.has('odd-spot')) {
    return {
      drillId: 'odd-spot',
      focusStep: null,
      reason: 'Solid round! Ready for something harder? Play in odd places inside the bar while the click stays on the beat.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Level ladders
// ---------------------------------------------------------------------------

const CLICK_LABELS: Readonly<Record<ClickPlacementMode, string>> = {
  all: 'click every step',
  beats: 'click on the beats',
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
    case 'odd-spot':
    case 'displacement':
    case 'groups-over-4':
    case 'strange-rhythms':
      return buildOffGridPlan(drillId, common, base.bpm);
    case 'note-length':
      return buildNoteLengthPlan(common, base.bpm);
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
// Off the Grid ladders
// ---------------------------------------------------------------------------

const OFF_GRID_ROUND_BARS: RoundLengthBars = 8;
const PLAIN_PULSE: Rhythm = { subdivision: 4, bars: ['x-.. x-.. x-.. x-..'] };

/** `"2a"` → `"the a of 2"`, `"3"` → `"beat 3"`, `"2let"` → `"the let of 2"`. */
function spotName(label: string): string {
  const beat = label[0];
  const sub = label.slice(1);
  return sub === '' ? `beat ${beat}` : `the ${sub} of ${beat}`;
}

interface OffGridStep {
  readonly label: string;
  readonly rhythm: Rhythm;
  readonly bpm: number;
  readonly windowMs: number;
  readonly bassGuideMode?: BassGuideMode;
}

/**
 * Ladders for the Off the Grid stage. Each level is a rhythm in odd places against a plain beat
 * click; the rhythm gets harder first, then the tempo and tolerance.
 */
function buildOffGridPlan(
  drillId: 'odd-spot' | 'displacement' | 'groups-over-4' | 'strange-rhythms',
  common: DrillSettings,
  baseBpm: number,
): DrillPlan {
  const start = clampBpm(Math.min(baseBpm, 100) * 0.8);
  const up = clampBpm(start + 8);
  const W = 25;
  const tight = 16;
  const spot = (spots: string[][], subdivision: 3 | 4 = 4): Rhythm => spotRhythm(spots, subdivision);
  const movingSpot = spot([['1a'], ['3e'], ['2&'], ['4a']]);

  let goal: string;
  let steps: OffGridStep[];
  switch (drillId) {
    case 'odd-spot': {
      const single = ['2&', '4&', '1a', '3a', '2e', '4e'].map((l) => ({
        label: `Only ${spotName(l)}`,
        rhythm: spot([[l]]),
        bpm: start,
        windowMs: W,
      }));
      goal = 'One note in an odd place. The click stays on the beat; count the 16ths in your head.';
      steps = [
        ...single,
        { label: `${spotName('1e')} + ${spotName('3a')}`, rhythm: spot([['1e', '3a']]), bpm: start, windowMs: W },
        { label: 'A moving spot (16ths)', rhythm: movingSpot, bpm: start, windowMs: W },
        { label: `Only ${spotName('2let')} (triplets)`, rhythm: spot([['2let']], 3), bpm: start, windowMs: W },
        {
          label: 'A moving spot (triplets)',
          rhythm: spot([['1trip'], ['3let'], ['2let'], ['4trip']], 3),
          bpm: start,
          windowMs: W,
        },
        { label: 'A moving spot (16ths)', rhythm: movingSpot, bpm: up, windowMs: W },
        { label: 'A moving spot (16ths)', rhythm: movingSpot, bpm: up, windowMs: tight },
      ];
      break;
    }
    case 'displacement': {
      const motown = regridRhythm(rhythmForPattern('motown-pocket', 1), 4);
      const funk = rhythmForPattern('funk-16th', 1);
      goal = "A groove you know, shifted off the beat. Keep it there; don't let it slide back.";
      steps = [
        { label: 'Quarters on the &', rhythm: displaceRhythm(PLAIN_PULSE, 2), bpm: start, windowMs: W },
        { label: 'Quarters on the a', rhythm: displaceRhythm(PLAIN_PULSE, 3), bpm: start, windowMs: W },
        { label: 'Quarters on the e', rhythm: displaceRhythm(PLAIN_PULSE, 1), bpm: start, windowMs: W },
        { label: 'Motown, an 8th late', rhythm: displaceRhythm(motown, 2), bpm: start, windowMs: W },
        { label: 'Motown, a 16th late', rhythm: displaceRhythm(motown, 1), bpm: start, windowMs: W },
        { label: 'Funk, an 8th late', rhythm: displaceRhythm(funk, 2), bpm: start, windowMs: W },
        { label: 'Funk, a 16th late', rhythm: displaceRhythm(funk, 1), bpm: start, windowMs: W },
        { label: 'Funk, a 16th late', rhythm: displaceRhythm(funk, 1), bpm: up, windowMs: tight },
      ];
      break;
    }
    case 'groups-over-4':
      goal = 'Groups of 3 (later 5) running across the bar line. Feel the groups and the 1 at the same time.';
      steps = [
        { label: '3+3+2 (8ths)', rhythm: groupsRhythm([3, 3, 2], 2), bpm: start, windowMs: W },
        { label: '3+3+3+3+4 (16ths)', rhythm: groupsRhythm([3, 3, 3, 3, 4], 4), bpm: start, windowMs: W },
        { label: 'Dotted 8ths across 3 bars', rhythm: groupsRhythm([3], 4), bpm: start, windowMs: W },
        { label: 'Quarter-note triplets', rhythm: groupsRhythm([2], 3), bpm: start, windowMs: W },
        { label: 'Dotted quarters across 3 bars', rhythm: groupsRhythm([3], 2), bpm: start, windowMs: W },
        { label: 'Groups of 5 (16ths) across 5 bars', rhythm: groupsRhythm([5], 4), bpm: start, windowMs: W },
        { label: 'Dotted 8ths across 3 bars', rhythm: groupsRhythm([3], 4), bpm: up, windowMs: tight },
        { label: 'Groups of 5 (16ths) across 5 bars', rhythm: groupsRhythm([5], 4), bpm: up, windowMs: tight },
      ];
      break;
    case 'strange-rhythms': {
      goal = 'Listen to the bar, then play it back. A new strange rhythm on every level.';
      const counts = [1, 2, 2, 3, 3, 4, 4, 5];
      const seen = new Set<string>();
      steps = counts.map((notes, i) => {
        let seed = 101 + i * 37;
        let rhythm = strangeRhythm(seed, { notes });
        while (seen.has(rhythm.bars[0])) {
          rhythm = strangeRhythm(++seed, { notes });
        }
        seen.add(rhythm.bars[0]);
        const last = i === counts.length - 1;
        return {
          label: `${notes} note${notes === 1 ? '' : 's'}, heard then echoed`,
          rhythm,
          bpm: i >= counts.length - 2 ? up : start,
          windowMs: last ? tight : W,
          bassGuideMode: 'call-response-1-1' as const,
        };
      });
      break;
    }
  }

  return {
    drillId,
    title: DRILL_TITLES[drillId],
    goal,
    focusStep: null,
    levels: steps.map((st) => {
      const settings: DrillSettings = {
        ...common,
        customRhythm: st.rhythm,
        clickPlacement: 'beats',
        gapBars: 0,
        pocketCenterMs: 0,
        drillMode: 'free',
        roundBars: OFF_GRID_ROUND_BARS,
        bassGuideMode: st.bassGuideMode ?? 'off',
        bpm: st.bpm,
        pocketWindowMs: st.windowMs,
      };
      return { settings, label: `${st.label} · ${st.bpm} BPM · ±${st.windowMs} ms` };
    }),
  };
}

// ---------------------------------------------------------------------------
// Note Length ladder
// ---------------------------------------------------------------------------

/**
 * Same kind of notes, different written lengths: the player has to end (mute) each note where it
 * is written. Lengths are graded, so every rhythm sets `gradeLengths`.
 */
function buildNoteLengthPlan(common: DrillSettings, baseBpm: number): DrillPlan {
  const start = clampBpm(Math.min(baseBpm, 100) * 0.8);
  const up = clampBpm(start + 8);
  const graded = (bars: string[], markReleases = false): Rhythm => ({
    subdivision: 4,
    bars,
    gradeLengths: true,
    ...(markReleases ? { markReleases: true } : {}),
  });
  const motown = { ...regridRhythm(rhythmForPattern('motown-pocket', 1), 4), gradeLengths: true };
  const funk = rhythmForPattern('funk-16th', 1);
  const eighths = ['x-..x-..x-..x-..'];
  const sixteenths = ['x...x...x...x...'];
  // [label, hint, rhythm, bpm, window]
  const steps: ReadonlyArray<readonly [string, string, Rhythm, number, number]> = [
    ['Quarters, held full', 'Hold each note a full beat: let it ring until you play the next one.', graded(['x---x---x---x---']), start, 25],
    ['8ths, with a let-go click', 'Play on the beat, let go on the "&". The soft click marks the "&": mute exactly on it.', graded(eighths, true), start, 25],
    ['8ths, no click', 'Same again, without the let-go click: play on the beat, mute on the "&".', graded(eighths), start, 25],
    ['Short 16ths, with a click', 'Very short: let go on the "e", right after the beat. The soft click marks it.', graded(sixteenths, true), start, 25],
    ['Short 16ths, no click', 'Very short notes again, now without the click: mute right after the beat.', graded(sixteenths), start, 25],
    ['Short, long, short, long', 'Beat 1 short (let go on the "&"), beat 2 long (hold the full beat), and so on.', graded(['x-..x---x-..x---']), start, 25],
    ['Long bar, short bar', 'Bar 1: hold every note a full beat. Bar 2: let go on every "&".', graded(['x---x---x---x---', 'x-..x-..x-..x-..']), start, 25],
    ['Motown lengths', 'Beat 1 rings through beat 2; the 2-& pickup is short; beats 3 and 4 ring a full beat.', motown, start, 25],
    ['Funk lengths', 'Funk is mostly short: copy the lengths you hear in the first bar.', funk, start, 25],
    ['Funk lengths', 'Funk lengths at a faster tempo, tighter.', funk, up, 16],
  ];
  return {
    drillId: 'note-length',
    title: DRILL_TITLES['note-length'],
    goal: "End every note where it's written: mute it on time. The bar under each block shows how long you held it.",
    focusStep: null,
    levels: steps.map(([label, hint, rhythm, bpm, windowMs]) => {
      const settings: DrillSettings = {
        ...common,
        customRhythm: rhythm,
        clickPlacement: 'beats',
        gapBars: 0,
        pocketCenterMs: 0,
        drillMode: 'free',
        roundBars: OFF_GRID_ROUND_BARS,
        // Hear the lengths first: the reference bass plays the first bar.
        bassGuideMode: 'demo-first',
        bpm,
        pocketWindowMs: windowMs,
      };
      return { settings, hint, label: `${label} · ${bpm} BPM · ±${windowMs} ms` };
    }),
  };
}

/**
 * Note Length rounds need both: notes that start in the pocket and end on time. Fail = < 60% in
 * the pocket or < 50% of lengths on time; pass = ≥ 70% and ≥ 75%. Neutral when too few releases
 * were heard to judge.
 */
export function judgeNoteLengthRound(
  summary: RoundSummary,
  releases: ReleaseSummary,
  expectedTargetCount: number,
): DrillVerdict {
  if (summary.inPocketPct < 60) return 'fail';
  if (releases.count < Math.max(4, expectedTargetCount * 0.5)) return 'neutral';
  if (releases.onTimePct < 50) return 'fail';
  return summary.inPocketPct >= 70 && releases.onTimePct >= 75 ? 'pass' : 'neutral';
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

/**
 * Lock-in staircase: nailing the goal (clean bars in a row) moves up a level at once, or completes
 * the drill on the top level; giving up twice in a row steps back a level.
 */
export function advanceLockIn(
  state: StaircaseState,
  outcome: 'nailed' | 'gave-up',
  levelCount: number,
): { state: StaircaseState; event: StaircaseEvent } {
  if (outcome === 'nailed') {
    return state.level >= levelCount - 1
      ? { state: startStaircase(state.level), event: 'complete' }
      : { state: startStaircase(state.level + 1), event: 'level-up' };
  }
  return advanceStaircase(state, 'fail', levelCount);
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
export function measureFocus(
  plan: DrillPlan,
  hits: readonly RoundHit[],
  releases: readonly ReleaseHit[] = [],
): FocusMeasurement {
  const round1 = (v: number): number => Math.round(v * 10) / 10;
  switch (plan.drillId) {
    case 'note-length':
      return {
        label: 'Note lengths on time',
        value: releases.length > 0 ? summarizeReleases(releases).onTimePct : null,
        unit: '%',
      };
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
    case 'odd-spot':
    case 'displacement':
    case 'groups-over-4':
    case 'strange-rhythms':
      return {
        label: 'Notes in the pocket',
        value: hits.length > 0 ? Math.round(pocketRate(hits) * 100) : null,
        unit: '%',
      };
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
