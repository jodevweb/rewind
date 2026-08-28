/**
 * Splitting stored events into work days, and running the engine over each.
 *
 * Everything downstream predicts from history, and history is a sequence of days rather than one
 * long undifferentiated stream. A transition from a context at 18:00 to one at 09:00 the next
 * morning is not a transition — it is a night.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { runEngine, type EngineContext } from '@rewind/engine-v0';

/** The 04:00 local cutoff, matching store.rs. A 01:30 event belongs to the previous day's work. */
export function workDay(timestampMs: number, tzOffsetMinutes: number): string {
  const shifted = timestampMs + tzOffsetMinutes * 60_000 - 4 * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

export interface WorkDay {
  day: string;
  events: GoldenEvent[];
  contexts: EngineContext[];
}

/**
 * Group events into work days and run the engine once per day.
 *
 * Per day rather than over everything at once, because the engine's own notions — drift, recency,
 * activity gaps — are calibrated to a day. Handing it a fortnight in one call would let last
 * Tuesday's anchors compete with this morning's.
 */
export function toWorkDays(session: GoldenSession): WorkDay[] {
  const byDay = new Map<string, GoldenEvent[]>();
  for (const e of session.events) {
    const day = workDay(e.timestamp, e.tzOffsetMinutes ?? session.tzOffsetMinutes);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, events]) => ({
      day,
      events,
      contexts: runEngine({ ...session, events }).contexts,
    }));
}

/** Local hour of the day, 0–23. */
export function hourOf(timestampMs: number, tzOffsetMinutes: number): number {
  return new Date(timestampMs + tzOffsetMinutes * 60_000).getUTCHours();
}

/** The identity a context keeps across days: its name is what recurs, not its generated id. */
export function contextKey(c: EngineContext): string {
  return (c.labelIsFallback ? `app:${c.label}` : c.label).toLowerCase();
}
