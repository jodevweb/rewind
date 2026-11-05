/**
 * The shape of a day, measured.
 *
 * This is the base the other three predictions stand on, and the answer to "keep everything so we
 * can do stats and KPIs and be deterministic". Every number here is counted, never modelled: given
 * the same events it returns the same figures on any machine, forever.
 *
 * What it deliberately does NOT do is score anyone. There is no "productivity", no target, no green
 * or red. A day with many short contexts is a fragmented day, which is a fact; whether that was the
 * right way to spend it is not something a window-title log can know, and a tool that pretends
 * otherwise becomes one people perform for rather than one they trust.
 */

import type { EngineContext } from '@rewind/engine-v0';

import { hourOf, type WorkDay } from './days.js';

/** A context this long with no interruption is deep work rather than a visit. */
const DEEP_WORK_MS = 25 * 60 * 1000;

export interface DayRhythm {
  day: string;
  /** Active time across every context. Idle excluded — the engine already did that. */
  activeMs: number;
  contextCount: number;
  /** Median context length. Median rather than mean: one long afternoon should not hide a fragmented morning. */
  medianContextMs: number;
  /** Contexts lasting at least 25 minutes, and their share of active time. */
  deepWorkCount: number;
  deepWorkMs: number;
  /** Switches between contexts, and the busiest hour for them. */
  switches: number;
  busiestSwitchHour: number | null;
  /** Hours where any context was active, earliest and latest. */
  firstHour: number | null;
  lastHour: number | null;
  /** Share of active time the engine could name from a subject rather than fall back to an app. */
  namedShare: number;
}

export interface Rhythm {
  days: DayRhythm[];
  /** Medians across days, for "a typical day" without one outlier day setting the tone. */
  typical: {
    activeMs: number;
    contextCount: number;
    medianContextMs: number;
    deepWorkMs: number;
    switches: number;
  };
  /** Hours of the day, 0–23, and how much active time usually lands in each. */
  activeMsByHour: number[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function rhythmOfDay(d: WorkDay, tzOffsetMinutes: number): DayRhythm {
  const ordered = [...d.contexts].sort((a, b) => a.startTimestamp - b.startTimestamp);
  const lengths = ordered.map((c) => c.activeMs);
  const activeMs = lengths.reduce((sum, v) => sum + v, 0);

  const deep = ordered.filter((c) => c.activeMs >= DEEP_WORK_MS);
  const named = ordered.filter((c) => !c.labelIsFallback);

  // A switch is a change of context, so a day with one context has none.
  const switchHours = ordered.slice(1).map((c) => hourOf(c.startTimestamp, tzOffsetMinutes));
  const byHour = new Map<number, number>();
  for (const h of switchHours) byHour.set(h, (byHour.get(h) ?? 0) + 1);
  let busiestSwitchHour: number | null = null;
  let busiest = 0;
  for (const [h, n] of byHour) {
    if (n > busiest) {
      busiest = n;
      busiestSwitchHour = h;
    }
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];

  return {
    day: d.day,
    activeMs,
    contextCount: ordered.length,
    medianContextMs: median(lengths),
    deepWorkCount: deep.length,
    deepWorkMs: deep.reduce((sum, c) => sum + c.activeMs, 0),
    switches: switchHours.length,
    busiestSwitchHour,
    firstHour: first ? hourOf(first.startTimestamp, tzOffsetMinutes) : null,
    lastHour: last ? hourOf(last.endTimestamp, tzOffsetMinutes) : null,
    namedShare: activeMs === 0 ? 0 : named.reduce((sum, c) => sum + c.activeMs, 0) / activeMs,
  };
}

/** Active time spread across the hours a context spans, so a long context is not credited to one hour. */
function spreadOverHours(c: EngineContext, tzOffsetMinutes: number, into: number[]): void {
  const span = Math.max(1, c.endTimestamp - c.startTimestamp);
  const share = c.activeMs / span;
  const HOUR = 3_600_000;
  for (let t = c.startTimestamp; t < c.endTimestamp; t += HOUR) {
    const slice = Math.min(HOUR, c.endTimestamp - t);
    into[hourOf(t, tzOffsetMinutes)]! += slice * share;
  }
}

export function rhythm(days: WorkDay[], tzOffsetMinutes: number): Rhythm {
  const perDay = days.map((d) => rhythmOfDay(d, tzOffsetMinutes));

  const activeMsByHour = new Array<number>(24).fill(0);
  for (const d of days) {
    for (const c of d.contexts) spreadOverHours(c, tzOffsetMinutes, activeMsByHour);
  }

  return {
    days: perDay,
    typical: {
      activeMs: median(perDay.map((d) => d.activeMs)),
      contextCount: median(perDay.map((d) => d.contextCount)),
      medianContextMs: median(perDay.map((d) => d.medianContextMs)),
      deepWorkMs: median(perDay.map((d) => d.deepWorkMs)),
      switches: median(perDay.map((d) => d.switches)),
    },
    activeMsByHour: activeMsByHour.map((v) => Math.round(v)),
  };
}
