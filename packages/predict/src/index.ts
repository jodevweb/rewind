/**
 * Local, deterministic prediction over stored events.
 *
 * No model, no training, no network, no API. Every figure is counted from the events on this machine
 * and recomputed each time, which is what keeps ADR 0005 D-13 true and what lets every claim show
 * the evidence it came from.
 *
 * The four questions, in the order they build on each other:
 *
 *   rhythm        what your days actually look like, as counted facts
 *   interruption  what leaving a piece of work has historically cost you
 *   resume        what you are likely to pick up next, and why
 *   drift         whether you are still on the thing you were on
 *
 * The rule they share: withhold rather than guess. Each refuses to answer without enough history,
 * because a confident wrong answer at the top of the window is worse than an empty panel — it
 * teaches the reader that the panel is noise, and that lesson is not un-taught.
 */

import type { GoldenSession } from '@rewind/fixtures/authoring';

import { hourOf, toWorkDays, type WorkDay } from './days.js';
import { interruptionCost, type InterruptionCost } from './interruption.js';
import { rhythm, type Rhythm } from './rhythm.js';
import { suggestNext, type Suggestion } from './resume.js';
import { detectDrift, type Drift } from './drift.js';

export * from './days.js';
export * from './rhythm.js';
export * from './interruption.js';
export * from './resume.js';
export * from './drift.js';

export interface Predictions {
  days: WorkDay[];
  rhythm: Rhythm;
  interruption: InterruptionCost;
  suggestions: Suggestion[];
  drift: Drift | null;
  /** How many days of history this was computed from. Shown, because it is the caveat. */
  daysOfHistory: number;
}

/**
 * Everything, from one session of stored events.
 *
 * `now` exists so the result is a pure function of its inputs: tests pin it, and the interface
 * passes the wall clock. Nothing in here reads the clock on its own.
 */
export function predict(session: GoldenSession, now: number = Date.now()): Predictions {
  const days = toWorkDays(session);
  const tz = session.tzOffsetMinutes;

  const interruption = interruptionCost(days);
  const today = days[days.length - 1];

  return {
    days,
    rhythm: rhythm(days, tz),
    interruption,
    suggestions: suggestNext(days, tz, {
      from: undefined,
      atHour: hourOf(now, tz),
      limit: 3,
    }),
    drift: today ? detectDrift(today.contexts, now, interruption) : null,
    daysOfHistory: days.length,
  };
}
