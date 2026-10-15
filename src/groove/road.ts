import type { KeyValueStorage } from './history';
import { maxBarsForGoal } from './lock-in';
import type { ClickPlacementMode } from './patterns';
import type { Rhythm } from './rhythm';
import type { GapClickMode } from './timeline';

/**
 * Groove Road: practice as one continuous run (see GROOVE_ROAD.md). Pure run logic only; the app
 * plays each section, judges it with the lock-in rules, and reports back with `nailSection`,
 * `breakSection` or `chooseFork`.
 */

export type RegionId = 'pulse-plains' | 'syncopation-city';
export type RoadKind = 'main' | 'fast' | 'ghost';

export interface RhythmCard {
  readonly label: string;
  readonly rhythm: Rhythm;
}

export interface Region {
  readonly id: RegionId;
  readonly name: string;
  readonly startBpm: number;
  /** Rhythms in the order the road brings them. */
  readonly deck: readonly RhythmCard[];
  readonly next: RegionId | null;
}

const card = (label: string, subdivision: 2 | 4, bar: string): RhythmCard => ({
  label,
  rhythm: { subdivision, bars: [bar] },
});

export const REGIONS: readonly Region[] = [
  {
    id: 'pulse-plains',
    name: 'Pulse Plains',
    startBpm: 72,
    next: 'syncopation-city',
    deck: [
      card('Quarter notes', 2, 'x-x- x-x-'),
      card('Quarter, two 8ths, quarter, quarter', 2, 'x-xx x-x-'),
      card('Quarter, two 8ths, twice', 2, 'x-xx x-xx'),
      card('Dotted quarter, 8th', 2, 'x--x x-x-'),
      card('Straight 8ths', 2, 'xxxx xxxx'),
      card('Rest on 4', 2, 'x-x- x-..'),
      card('Rest on 1, pickup on 2-&', 2, '..xx x-x-'),
    ],
  },
  {
    id: 'syncopation-city',
    name: 'Syncopation City',
    startBpm: 76,
    next: null,
    deck: [
      card('8ths on a 16th grid', 4, 'x-x- x-x- x-x- x-x-'),
      card('3 + 3 + 2', 4, 'x--x --x- x--x --x-'),
      card('Anticipate beat 3', 4, 'x-x- x-.x --x- x-x-'),
      card('16th pickups', 4, 'x--x x-x- x--x x-x-'),
      card('Funk pocket', 4, 'x-.x ..x- xx-- ..x-'),
      card('Off-beat 16ths', 4, 'x..x .x.. x..x .x..'),
    ],
  },
];

export function regionById(id: RegionId): Region {
  const r = REGIONS.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown region ${id}`);
  return r;
}

export interface ForkOption {
  readonly road: RoadKind;
  readonly name: string;
  /** Pitch class to play on the 1 to take this road. */
  readonly note: 'E' | 'A';
}

export interface RoadSection {
  readonly kind: 'groove' | 'fork';
  readonly label: string;
  readonly rhythm: Rhythm;
  readonly bpm: number;
  /** Clean bars in a row to nail the section. */
  readonly goalBars: number;
  /** Bars allowed before the section counts as broken. */
  readonly maxBars: number;
  readonly clickPlacement: ClickPlacementMode;
  readonly gapBars: GapClickMode;
  /** Band layer. */
  readonly band: number;
  /** Play the rhythm first (a listen bar) because it is new. */
  readonly demoFirst: boolean;
  readonly fork?: { readonly left: ForkOption; readonly right: ForkOption };
}

export interface RunState {
  readonly region: RegionId;
  readonly deckIndex: number;
  readonly bpm: number;
  readonly hearts: number;
  /** Sections nailed this run (the run's distance). */
  readonly nailed: number;
  readonly band: number;
  readonly road: RoadKind;
  /** Sections left on a side road before it merges back. */
  readonly roadLeft: number;
  readonly sinceFork: number;
  readonly nextAdapt: 'tempo' | 'rhythm';
  readonly rhythmIsNew: boolean;
  readonly atFork: boolean;
  readonly over: boolean;
  readonly regionsReached: readonly RegionId[];
  readonly topBpm: number;
}

export const MAX_HEARTS = 3;
export const MAX_BAND = 5;
/** Nailed main-road sections between forks. */
export const FORK_EVERY = 4;
const SIDE_ROAD_SECTIONS = 3;
const MIN_BPM = 50;
const MAX_BPM = 220;
const TEMPO_STEP = 4;
const BREAK_SLOWDOWN = 6;
const FAST_LANE_BOOST = 12;

const LEFT: ForkOption = { road: 'fast', name: 'Fast lane', note: 'E' };
const RIGHT: ForkOption = { road: 'ghost', name: 'Ghost road', note: 'A' };

/** Clean bars in a row per section: 2 to start, 4 after a few sections, then 8. */
export function goalBarsForDepth(nailed: number): number {
  return nailed < 3 ? 2 : nailed < 10 ? 4 : 8;
}

export function startRun(camp: RegionId): RunState {
  const region = regionById(camp);
  return {
    region: camp,
    deckIndex: 0,
    bpm: region.startBpm,
    hearts: MAX_HEARTS,
    nailed: 0,
    band: 0,
    road: 'main',
    roadLeft: 0,
    sinceFork: 0,
    nextAdapt: 'tempo',
    rhythmIsNew: true,
    atFork: false,
    over: false,
    regionsReached: [camp],
    topBpm: region.startBpm,
  };
}

export function currentSection(s: RunState): RoadSection {
  if (s.atFork) {
    return {
      kind: 'fork',
      label: `Fork: E on the 1 → ${LEFT.name} · A on the 1 → ${RIGHT.name}`,
      rhythm: { subdivision: 1, bars: ['x...'] },
      bpm: s.bpm,
      goalBars: 1,
      maxBars: 2,
      clickPlacement: 'offbeat-and',
      gapBars: 0,
      band: s.band,
      demoFirst: false,
      fork: { left: LEFT, right: RIGHT },
    };
  }
  const region = regionById(s.region);
  const c = region.deck[s.deckIndex];
  const goalBars = goalBarsForDepth(s.nailed);
  let clickPlacement: ClickPlacementMode = 'beats';
  let gapBars: GapClickMode = 0;
  let road = '';
  if (s.road === 'ghost') {
    road = ' · Ghost road';
    if (s.roadLeft >= 3) clickPlacement = 'backbeat-2-4';
    else if (s.roadLeft === 2) clickPlacement = 'one-drop-1';
    else gapBars = 1;
  } else if (s.road === 'fast') {
    road = ' · Fast lane';
  }
  return {
    kind: 'groove',
    label: `${c.label}${road}`,
    rhythm: c.rhythm,
    bpm: s.bpm,
    goalBars,
    maxBars: maxBarsForGoal(goalBars),
    clickPlacement,
    gapBars,
    band: s.band,
    demoFirst: s.rhythmIsNew && s.road !== 'ghost',
    fork: undefined,
  };
}

const clampBpm = (bpm: number): number => Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));

export function nailSection(s: RunState): RunState {
  if (s.over || s.atFork) return s;
  let next: RunState = {
    ...s,
    nailed: s.nailed + 1,
    band: Math.min(MAX_BAND, s.band + 1),
    rhythmIsNew: false,
  };
  if (s.road !== 'main') {
    const roadLeft = s.roadLeft - 1;
    next = { ...next, roadLeft, road: roadLeft <= 0 ? 'main' : s.road };
    if (s.road === 'ghost') {
      // The Ghost road is about keeping time with less help: no speed-ups or new rhythms on it.
      return next;
    }
  } else {
    next = { ...next, sinceFork: s.sinceFork + 1 };
  }

  const region = regionById(s.region);
  if (s.nextAdapt === 'tempo') {
    next = { ...next, bpm: clampBpm(s.bpm + TEMPO_STEP), nextAdapt: 'rhythm' };
  } else if (s.deckIndex < region.deck.length - 1) {
    next = { ...next, deckIndex: s.deckIndex + 1, rhythmIsNew: true, nextAdapt: 'tempo' };
  } else if (region.next) {
    const nextRegion = regionById(region.next);
    next = {
      ...next,
      region: nextRegion.id,
      deckIndex: 0,
      bpm: clampBpm(Math.max(nextRegion.startBpm, s.bpm - 10)),
      rhythmIsNew: true,
      nextAdapt: 'tempo',
      regionsReached: s.regionsReached.includes(nextRegion.id)
        ? s.regionsReached
        : [...s.regionsReached, nextRegion.id],
    };
  } else {
    // The last region is endless: keep speeding up.
    next = { ...next, bpm: clampBpm(s.bpm + TEMPO_STEP) };
  }

  if (next.road === 'main' && s.road === 'main' && next.sinceFork >= FORK_EVERY) {
    next = { ...next, atFork: true, sinceFork: 0 };
  }
  return { ...next, topBpm: Math.max(next.topBpm, next.bpm) };
}

export function breakSection(s: RunState): RunState {
  if (s.over || s.atFork) return s;
  const hearts = s.hearts - 1;
  return {
    ...s,
    hearts,
    band: Math.max(0, s.band - 1),
    bpm: clampBpm(s.bpm - BREAK_SLOWDOWN),
    rhythmIsNew: s.road !== 'ghost',
    over: hearts <= 0,
  };
}

/** Resolves a fork: `'left'` (played E), `'right'` (played A), or `null` (straight on). */
export function chooseFork(s: RunState, choice: 'left' | 'right' | null): RunState {
  if (!s.atFork) return s;
  const base = { ...s, atFork: false, rhythmIsNew: false };
  if (choice === 'left') {
    const bpm = clampBpm(s.bpm + FAST_LANE_BOOST);
    return { ...base, road: 'fast', roadLeft: SIDE_ROAD_SECTIONS, bpm, topBpm: Math.max(s.topBpm, bpm) };
  }
  if (choice === 'right') {
    return { ...base, road: 'ghost', roadLeft: SIDE_ROAD_SECTIONS };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Progress between runs
// ---------------------------------------------------------------------------

export interface RoadProgress {
  /** Regions you can start a run from. */
  readonly camps: readonly RegionId[];
  readonly bestNailed: number;
  readonly topBpm: number;
  readonly runs: number;
}

const ROAD_KEY = 'groovelock.road.v1';
const EMPTY_PROGRESS: RoadProgress = { camps: ['pulse-plains'], bestNailed: 0, topBpm: 0, runs: 0 };

const isRegionId = (v: unknown): v is RegionId => REGIONS.some((r) => r.id === v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export function loadRoadProgress(storage: KeyValueStorage): RoadProgress {
  try {
    const raw = JSON.parse(storage.getItem(ROAD_KEY) ?? '{}') as Record<string, unknown>;
    const camps = Array.isArray(raw.camps) ? raw.camps.filter(isRegionId) : [];
    return {
      camps: REGIONS.map((r) => r.id).filter((id) => id === 'pulse-plains' || camps.includes(id)),
      bestNailed: count(raw.bestNailed),
      topBpm: count(raw.topBpm),
      runs: count(raw.runs),
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function saveRoadProgress(progress: RoadProgress, storage: KeyValueStorage): void {
  try {
    storage.setItem(ROAD_KEY, JSON.stringify(progress));
  } catch {
    // Ignore quota / private-browsing errors.
  }
}

/** Adds a finished run: camps for every region reached, best distance and tempo. */
export function recordRun(progress: RoadProgress, run: RunState): RoadProgress {
  const reached = new Set<RegionId>([...progress.camps, ...run.regionsReached]);
  return {
    camps: REGIONS.map((r) => r.id).filter((id) => reached.has(id)),
    bestNailed: Math.max(progress.bestNailed, run.nailed),
    topBpm: Math.max(progress.topBpm, run.topBpm),
    runs: progress.runs + 1,
  };
}
