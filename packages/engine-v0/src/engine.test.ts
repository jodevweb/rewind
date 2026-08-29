/**
 * Active time, and the one property it must never violate.
 *
 * A context cannot have been active for longer than the day it happened in. That sounds too obvious
 * to test, and it was false for every context on this machine: a real day read 31.5 hours of active
 * time inside 23.7 hours of wall clock. Nothing on the golden set could catch it — hand-authored
 * activities do not overlap, and overlap is the whole bug.
 */

import { describe, expect, it } from 'vitest';

import { coveredMs, type Activity } from './engine.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function activity(startMinutes: number, endMinutes: number): Activity {
  return {
    id: `a-${startMinutes}-${endMinutes}`,
    startTimestamp: startMinutes * MINUTE,
    endTimestamp: endMinutes * MINUTE,
    eventRefs: [],
    apps: [],
    anchors: [],
    contextId: null,
  } as unknown as Activity;
}

describe('active time', () => {
  it('counts an hour once when two activities cover the same hour', () => {
    // A nine-hour agent session sitting on top of two hundred window-focus spans is the real shape
    // of this: adding both counts the same afternoon twice.
    const covered = coveredMs([activity(0, 60), activity(10, 50)]);
    expect(covered).toBe(HOUR);
  });

  it('joins two overlapping activities into the time they span together', () => {
    expect(coveredMs([activity(0, 60), activity(30, 90)])).toBe(90 * MINUTE);
  });

  it('never counts the gap between two activities', () => {
    // The reason this was a sum in the first place, and the property a union has to preserve:
    // lunch, a meeting and other work in between are not this context's time (§69).
    expect(coveredMs([activity(0, 60), activity(180, 240)])).toBe(2 * HOUR);
  });

  it('does not care what order the activities arrive in', () => {
    const forwards = coveredMs([activity(0, 60), activity(120, 180), activity(30, 90)]);
    const backwards = coveredMs([activity(30, 90), activity(120, 180), activity(0, 60)]);
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(90 * MINUTE + HOUR);
  });

  it('swallows an activity entirely contained in another', () => {
    expect(coveredMs([activity(0, 240), activity(60, 120), activity(90, 100)])).toBe(4 * HOUR);
  });

  it('gives an instant its floor rather than zero', () => {
    // One event that started and finished in the same moment is still a moment of work.
    expect(coveredMs([activity(0, 0)])).toBe(30_000);
  });

  it('does not turn two nearby instants into a minute', () => {
    // The floor is applied to each interval before the union, not after it.
    const almostTogether = coveredMs([
      activity(0, 0),
      { ...activity(0, 0), id: 'b', startTimestamp: 1000, endTimestamp: 1000 } as Activity,
    ]);
    expect(almostTogether).toBe(31_000);
  });

  it('says nothing about a context with no activities', () => {
    expect(coveredMs([])).toBe(0);
  });

  it('cannot exceed the wall clock it happened in', () => {
    // The invariant the whole thing exists for. Two hundred activities inside one hour, in every
    // arrangement of overlap, still add up to one hour.
    const many = Array.from({ length: 200 }, (_, i) => activity(i % 60, (i % 60) + 5));
    expect(coveredMs(many)).toBeLessThanOrEqual(65 * MINUTE);
  });
});
