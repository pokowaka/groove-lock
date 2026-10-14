import type { DrillId } from './drills';
import type { CoachProgress } from './history';
import { isMastered } from './history';

/**
 * The Time Path: the curriculum that links the drills into one route, from a steady pulse to
 * shifting odd meters (see TIME_PATH.md). Stages that are not built yet are listed as "coming"
 * so the route is visible from day one.
 *
 * The path guides, it never gates: every drill stays playable at any time.
 */

export type StageId =
  | 'pulse'
  | 'subdivision'
  | 'space'
  | 'off-grid'
  | 'feel'
  | 'threes'
  | 'odd'
  | 'long-odd'
  | 'shifting';

export interface PathItem {
  readonly title: string;
  /** The drill that trains it, or `null` while it is still being built. */
  readonly drillId: DrillId | null;
}

export interface PathStage {
  readonly id: StageId;
  /** Display number (`"3b"` for the branch stage). */
  readonly number: string;
  readonly title: string;
  /** One line: the skill this stage builds. */
  readonly skill: string;
  /** The style groove that will close the stage (its "boss level"). */
  readonly boss: string;
  /** Stages that should come first. */
  readonly after: readonly StageId[];
  readonly items: readonly PathItem[];
}

const soon = (title: string): PathItem => ({ title, drillId: null });
const drill = (title: string, drillId: DrillId): PathItem => ({ title, drillId });

export const TIME_PATH: readonly PathStage[] = [
  {
    id: 'pulse',
    number: '1',
    title: 'Pulse',
    skill: 'Every quarter note lands the same.',
    boss: 'Motown',
    after: [],
    items: [drill('Steady Quarters', 'steady-quarters'), soon('Tempo Ladder')],
  },
  {
    id: 'subdivision',
    number: '2',
    title: 'Subdivision',
    skill: 'Feel the 8ths, 16ths and triplets between the beats.',
    boss: 'Disco (Chic)',
    after: ['pulse'],
    items: [soon('Subdivide'), soon('8ths · 16ths · triplets')],
  },
  {
    id: 'space',
    number: '3',
    title: 'Space',
    skill: 'Keep time through rests and with less click.',
    boss: 'Reggae one drop',
    after: ['subdivision'],
    items: [
      drill('Ghost Drummer', 'ghost-drummer'),
      drill('Note Length', 'note-length'),
      soon('Wait for It'),
      soon('Backbeat Bounce'),
    ],
  },
  {
    id: 'off-grid',
    number: '3b',
    title: 'Off the Grid',
    skill: 'Play in odd places inside the bar while the click stays on the beat.',
    boss: 'Funk (on the one)',
    after: ['space'],
    items: [
      drill('Odd Spot', 'odd-spot'),
      drill('Displacement', 'displacement'),
      drill('Groups Over 4', 'groups-over-4'),
      drill('Strange Rhythms', 'strange-rhythms'),
    ],
  },
  {
    id: 'feel',
    number: '4',
    title: 'Feel',
    skill: 'Sit behind or on top of the beat on purpose.',
    boss: 'Neo-soul',
    after: ['subdivision'],
    items: [drill('Lay It Back', 'lay-it-back'), drill('On Top', 'on-top'), soon('Feel Shifter')],
  },
  {
    id: 'threes',
    number: '5',
    title: 'Threes',
    skill: 'Feel groups of three: 3/4, 6/8, 12/8.',
    boss: 'Shuffle / 12/8 blues',
    after: ['subdivision'],
    items: [soon('3/4 and 6/8 pulse'), soon('Group Heads')],
  },
  {
    id: 'odd',
    number: '6',
    title: 'Odd',
    skill: '5 and 7 as chains of 2s and 3s.',
    boss: 'Prog rock (Rush-style)',
    after: ['threes', 'off-grid'],
    items: [soon('5/8 · 5/4'), soon('7/8 (2+2+3, 3+2+2, 2+3+2)')],
  },
  {
    id: 'long-odd',
    number: '7',
    title: 'Long odd',
    skill: '9, 11 and 13 with a sparse click.',
    boss: 'Math rock',
    after: ['odd'],
    items: [soon('9/8 · 11/8 · 13/8')],
  },
  {
    id: 'shifting',
    number: '8',
    title: 'Shifting meters',
    skill: 'Meters that change from bar to bar, with feel.',
    boss: 'Math rock (Angine de Poitrine-style)',
    after: ['long-odd', 'feel'],
    items: [soon('Meter Switch')],
  },
];

export type StageState =
  /** Nothing playable yet. */
  | 'soon'
  /** Earlier stages are not done yet (still playable). */
  | 'later'
  /** Ready: earlier stages are done. */
  | 'open'
  /** Some of its drills have been played. */
  | 'started'
  /** Every drill completed at least once. */
  | 'completed'
  /** Every drill mastered (completed on two different days). */
  | 'mastered';

function playable(stage: PathStage): DrillId[] {
  return stage.items.flatMap((i) => (i.drillId ? [i.drillId] : []));
}

function isCompleted(progress: CoachProgress, id: DrillId): boolean {
  return (progress[id]?.completionDays.length ?? 0) > 0;
}

function stageById(id: StageId): PathStage | undefined {
  return TIME_PATH.find((s) => s.id === id);
}

/** `true` when every playable drill of the stage and of the stages before it is completed once. */
function isDone(stage: PathStage, progress: CoachProgress): boolean {
  return (
    playable(stage).every((id) => isCompleted(progress, id)) && prerequisitesDone(stage, progress)
  );
}

function prerequisitesDone(stage: PathStage, progress: CoachProgress): boolean {
  return stage.after.every((dep) => {
    const s = stageById(dep);
    return s ? isDone(s, progress) : true;
  });
}

export function stageState(stage: PathStage, progress: CoachProgress): StageState {
  const ids = playable(stage);
  if (ids.length === 0) return 'soon';
  if (ids.every((id) => isMastered(progress, id))) return 'mastered';
  if (ids.every((id) => isCompleted(progress, id))) return 'completed';
  if (ids.some((id) => progress[id] !== undefined)) return 'started';
  return prerequisitesDone(stage, progress) ? 'open' : 'later';
}

/**
 * The drill to do next: the first drill (in path order) whose earlier stages are done and that
 * is not completed yet; once everything open is completed, the first one still to master.
 * `null` when everything is mastered.
 */
export function nextUp(progress: CoachProgress): { stageId: StageId; drillId: DrillId } | null {
  for (const stage of TIME_PATH) {
    if (!prerequisitesDone(stage, progress)) continue;
    const id = playable(stage).find((d) => !isCompleted(progress, d));
    if (id) return { stageId: stage.id, drillId: id };
  }
  for (const stage of TIME_PATH) {
    const id = playable(stage).find((d) => !isMastered(progress, d));
    if (id) return { stageId: stage.id, drillId: id };
  }
  return null;
}
