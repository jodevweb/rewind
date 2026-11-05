/**
 * What leaving a context actually costs.
 *
 * Everyone quotes a number for this — twenty-three minutes is the usual one — and nobody measures
 * it on their own work. The data to measure it has been sitting in the store all along: every time
 * a context stops and later resumes, the gap between them is an observation, and the length of the
 * fragment that follows the return says whether the thread was picked up or dropped again.
 *
 * Two things are computed, and they answer different questions:
 *
 *   - **Return time**: how long, historically, before you come back to a context you left. This is
 *     measured, not predicted, and it is a median so one abandoned afternoon does not set the tone.
 *   - **Return rate**: how often you come back at all. A context left and never resumed cost more
 *     than the clock says, and that is the number worth seeing before switching.
 *
 * A prediction is only offered where there is enough history to support it. Saying "this will cost
 * you 23 minutes" from two observations is worse than saying nothing, because it will be believed.
 */

import type { EngineContext } from '@rewind/engine-v0';

import { contextKey, type WorkDay } from './days.js';

/** Below this, an interruption prediction is withheld rather than guessed. */
const MIN_OBSERVATIONS = 3;

export interface Interruption {
  /** The context that was left. */
  key: string;
  label: string;
  /** When it was left, and when it resumed. */
  leftAt: number;
  returnedAt: number;
  awayMs: number;
  /** Active time in the context after the return. A short one means the thread was not picked up. */
  resumedForMs: number;
}

export interface InterruptionCost {
  observations: Interruption[];
  /** Median time away before returning, across every observed interruption. */
  medianReturnMs: number | null;
  /** Of the contexts left at least once, the share that were ever resumed. */
  returnRate: number | null;
  /** Per context, for the ones with enough history to say anything. */
  byContext: Map<
    string,
    { label: string; medianReturnMs: number; returns: number; abandoned: number }
  >;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * Every departure and return, read out of the day's contexts.
 *
 * The engine already merges a context that resumes after a short interruption, so a context
 * appearing twice in one day means the engine judged them different pieces of work. Interruptions
 * are therefore read from the ORDER contexts were active in: leaving A for B and later returning to
 * a context with the same name is a return.
 */
function interruptionsIn(day: WorkDay): Interruption[] {
  const ordered = [...day.contexts].sort((a, b) => a.startTimestamp - b.startTimestamp);
  const lastSeen = new Map<string, EngineContext>();
  const out: Interruption[] = [];

  for (const c of ordered) {
    const key = contextKey(c);
    const previous = lastSeen.get(key);
    if (previous && c.startTimestamp > previous.endTimestamp) {
      out.push({
        key,
        label: c.label,
        leftAt: previous.endTimestamp,
        returnedAt: c.startTimestamp,
        awayMs: c.startTimestamp - previous.endTimestamp,
        resumedForMs: c.activeMs,
      });
    }
    lastSeen.set(key, c);
  }
  return out;
}

export function interruptionCost(days: WorkDay[]): InterruptionCost {
  const observations = days.flatMap(interruptionsIn);

  // Every context that was ever left: it was active, and something else was active after it.
  const left = new Set<string>();
  const returned = new Set<string>();
  for (const day of days) {
    const ordered = [...day.contexts].sort((a, b) => a.startTimestamp - b.startTimestamp);
    const seen = new Set<string>();
    for (let i = 0; i < ordered.length; i += 1) {
      const key = contextKey(ordered[i]!);
      if (seen.has(key)) returned.add(key);
      seen.add(key);
      if (i < ordered.length - 1) left.add(key);
    }
  }

  const byContext = new Map<
    string,
    { label: string; medianReturnMs: number; returns: number; abandoned: number }
  >();
  const grouped = new Map<string, Interruption[]>();
  for (const o of observations) {
    const list = grouped.get(o.key) ?? [];
    list.push(o);
    grouped.set(o.key, list);
  }
  for (const [key, list] of grouped) {
    if (list.length < MIN_OBSERVATIONS) continue;
    byContext.set(key, {
      label: list[0]!.label,
      medianReturnMs: median(list.map((o) => o.awayMs)),
      returns: list.length,
      abandoned: 0,
    });
  }

  return {
    observations,
    medianReturnMs:
      observations.length >= MIN_OBSERVATIONS ? median(observations.map((o) => o.awayMs)) : null,
    returnRate: left.size === 0 ? null : returned.size / left.size,
    byContext,
  };
}
