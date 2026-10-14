import { describe, expect, it } from 'vitest';
import {
  describeReleases,
  gradeRelease,
  type ReleaseHit,
  releaseWindowMs,
  summarizeReleases,
} from '../src/groove/release-grading';

const base = {
  latencyCompensationMs: 0,
  targetTimeSec: 10,
  pocketCenterMs: 0,
  bpm: 120, // 500 ms per beat
  windowMs: 30,
};

describe('gradeRelease', () => {
  it('judges the release against the written end of the note', () => {
    // An 8th note (0.5 beat = 250 ms) ends at 10.25 s.
    expect(gradeRelease({ ...base, lengthBeats: 0.5, releaseTimeSec: 10.26 })).toEqual({
      deltaMs: 10,
      judgment: 'on-time',
      targetEndSec: 10.25,
    });
    expect(gradeRelease({ ...base, lengthBeats: 0.5, releaseTimeSec: 10.2 }).judgment).toBe('short');
    expect(gradeRelease({ ...base, lengthBeats: 0.5, releaseTimeSec: 10.3 }).judgment).toBe('long');
  });

  it('applies latency compensation and the feel offset', () => {
    const r = gradeRelease({
      ...base,
      lengthBeats: 1,
      latencyCompensationMs: 20,
      pocketCenterMs: 12,
      releaseTimeSec: 10.532,
    });
    // Heard at 10.512 after compensation; laid-back note should end at 10.512.
    expect(r.deltaMs).toBeCloseTo(0, 6);
    expect(r.judgment).toBe('on-time');
  });

  it('uses a release window twice the pocket window, never under 30 ms', () => {
    expect(releaseWindowMs(16)).toBe(32);
    expect(releaseWindowMs(25)).toBe(50);
    expect(releaseWindowMs(10)).toBe(30);
  });
});

const hit = (deltaMs: number, judgment: ReleaseHit['judgment']): ReleaseHit => ({
  stepKey: '0:0',
  stepName: '1',
  deltaMs,
  judgment,
});

describe('summarizeReleases / describeReleases', () => {
  it('summarizes how many notes ended on time and the average error', () => {
    const s = summarizeReleases([hit(-40, 'short'), hit(-50, 'short'), hit(5, 'on-time'), hit(-45, 'short')]);
    expect(s.count).toBe(4);
    expect(s.onTimePct).toBe(25);
    expect(s.meanDeltaMs).toBeCloseTo(-32.5);
    expect(describeReleases(s)).toMatch(/25% on time/);
    expect(describeReleases(s)).toMatch(/cut notes short by 33 ms/);
  });

  it('says when notes are held too long', () => {
    const s = summarizeReleases([hit(60, 'long'), hit(70, 'long'), hit(10, 'on-time')]);
    expect(describeReleases(s)).toMatch(/hold notes 47 ms too long/);
  });

  it('praises lengths that are on time and says nothing without data', () => {
    const s = summarizeReleases([hit(5, 'on-time'), hit(-8, 'on-time'), hit(12, 'on-time')]);
    expect(describeReleases(s)).toMatch(/100% on time/);
    expect(describeReleases(summarizeReleases([]))).toBeNull();
  });
});
