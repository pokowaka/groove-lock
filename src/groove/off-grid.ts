import { parseRhythm, type Rhythm } from './rhythm';
import type { Subdivision } from './timeline';

/**
 * Rhythm builders for the Off the Grid stage: notes in odd places inside a plain 4/4 bar.
 * All of them return ordinary `Rhythm` masks, so they play, grade and draw like any groove.
 */

const BEATS_PER_BAR = 4;

const SPOT_SUFFIXES: Readonly<Record<3 | 4, readonly string[]>> = {
  4: ['', 'e', '&', 'a'],
  3: ['', 'trip', 'let'],
};

/** Step index of a spot label like `"2a"`, `"3&"`, `"4"` or `"2let"` (triplets). */
function spotStep(label: string, subdivision: 3 | 4): number {
  const m = /^([1-4])(.*)$/.exec(label);
  const sub = m ? SPOT_SUFFIXES[subdivision].indexOf(m[2]) : -1;
  if (!m || sub < 0) {
    throw new Error(`Unknown spot "${label}" on a ${subdivision === 4 ? '16th' : 'triplet'} grid`);
  }
  return (Number(m[1]) - 1) * subdivision + sub;
}

/**
 * One short note on each named spot; one list of spots per bar.
 *
 * @example spotRhythm([['2a']]) // only the "a" of 2
 */
export function spotRhythm(
  spotsPerBar: readonly (readonly string[])[],
  subdivision: 3 | 4 = 4,
): Rhythm {
  const bars = spotsPerBar.map((spots) => {
    const mask = Array<string>(BEATS_PER_BAR * subdivision).fill('.');
    for (const label of spots) {
      mask[spotStep(label, subdivision)] = 'x';
    }
    return mask.join('');
  });
  return parseRhythm({ subdivision, bars });
}

/** Rewrites a rhythm on a finer grid (e.g. 8ths → 16ths) without changing how it sounds. */
export function regridRhythm(rhythm: Rhythm, subdivision: Subdivision): Rhythm {
  const r = parseRhythm(rhythm);
  if (subdivision % r.subdivision !== 0) {
    throw new Error(`Cannot move a ${r.subdivision}-step grid to a ${subdivision}-step grid`);
  }
  const factor = subdivision / r.subdivision;
  const widen = (c: string): string => c + (c === '.' ? '.' : '-').repeat(factor - 1);
  return parseRhythm({
    ...r,
    subdivision,
    bars: r.bars.map((bar) => [...bar].map(widen).join('')),
  });
}

/** Shifts a whole phrase later by `steps` grid steps; what falls off the end wraps to the start. */
export function displaceRhythm(rhythm: Rhythm, steps: number): Rhythm {
  const r = parseRhythm(rhythm);
  const phrase = r.bars.join('');
  const n = phrase.length;
  const k = ((steps % n) + n) % n;
  const shifted = phrase.slice(n - k) + phrase.slice(0, n - k);
  const barLen = r.bars[0].length;
  return parseRhythm({
    ...r,
    bars: r.bars.map((_, i) => shifted.slice(i * barLen, (i + 1) * barLen)),
  });
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Accented groups (e.g. `[3, 3, 3, 3, 4]` or `[3]`) running across the bar lines, repeated until
 * they line up with the bar again. Each note is held for its group.
 */
export function groupsRhythm(groups: readonly number[], subdivision: Subdivision): Rhythm {
  if (groups.length === 0 || groups.some((g) => !Number.isInteger(g) || g < 1)) {
    throw new Error('Groups must be positive whole numbers of steps');
  }
  const cell = groups.map((g) => 'x' + '-'.repeat(g - 1)).join('');
  const barLen = BEATS_PER_BAR * subdivision;
  const total = (cell.length * barLen) / gcd(cell.length, barLen);
  const phrase = cell.repeat(total / cell.length);
  const bars = Array.from({ length: total / barLen }, (_, i) =>
    phrase.slice(i * barLen, (i + 1) * barLen),
  );
  return parseRhythm({ subdivision, bars });
}

/** Small seeded PRNG (mulberry32), so a level always gets the same rhythm. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A lopsided one-bar 16th rhythm: `notes` notes at least an 8th apart, at least half of them off
 * the beat, each held for a random part of the gap to the next note.
 */
export function strangeRhythm(seed: number, opts: { notes: number }): Rhythm {
  const rand = mulberry32(seed);
  const steps = BEATS_PER_BAR * 4;
  const notes = Math.max(1, Math.min(6, Math.floor(opts.notes)));
  const minOffBeat = Math.ceil(notes / 2);

  for (let attempt = 0; attempt < 1000; attempt++) {
    const picked = new Set<number>();
    while (picked.size < notes) {
      picked.add(Math.floor(rand() * steps));
    }
    const pos = [...picked].sort((a, b) => a - b);
    const spaced = pos.every((p, i) => i === 0 || p - pos[i - 1] >= 2);
    const wrapOk = pos.length < 2 || pos[0] + steps - pos[pos.length - 1] >= 2;
    const offBeat = pos.filter((p) => p % 4 !== 0).length;
    if (!spaced || !wrapOk || offBeat < minOffBeat) {
      continue;
    }
    const mask = Array<string>(steps).fill('.');
    pos.forEach((p, i) => {
      const next = i + 1 < pos.length ? pos[i + 1] : pos[0] + steps;
      const hold = Math.floor(rand() * (next - p));
      mask[p] = 'x';
      for (let k = 1; k <= hold && p + k < steps; k++) {
        mask[p + k] = '-';
      }
    });
    return parseRhythm({ subdivision: 4, bars: [mask.join('')] });
  }
  throw new Error(`No rhythm with ${notes} notes found`);
}
