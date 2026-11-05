/**
 * What you will come back to, and roughly when.
 *
 * Two signals, both counted rather than modelled:
 *
 *   - **Transitions.** After finishing context A you have historically gone to B. A first-order
 *     Markov count over context names, which is the least clever thing that works and the only one
 *     that can show its evidence: "four times out of six, after X you went to Y".
 *   - **Hour of day.** Some work only ever happens at certain hours. Invoicing on Friday afternoon,
 *     stand-up notes at nine. A context's historical distribution over hours is a prior.
 *
 * The two are combined multiplicatively, so a context has to be both a plausible successor AND
 * plausible at this hour. That is stricter than either alone and it is the right bias: a wrong
 * suggestion at the top of the window costs more than an empty one, because it teaches people that
 * the panel is noise.
 *
 * Nothing here is trained, stored or carried between machines. It is recomputed from the events on
 * this machine every time, which is what makes it explainable and what keeps ADR 0005 D-13 true.
 */

import { contextKey, hourOf, type WorkDay } from './days.js';

/** Fewer transitions than this and the ranking is noise wearing a number. */
const MIN_TRANSITIONS = 4;

export interface Suggestion {
  key: string;
  label: string;
  /** 0..1. Not a probability — a ranking score. Presented as an order, never as a percentage. */
  score: number;
  /** Why, in the terms the numbers were counted in. The interface shows this verbatim. */
  evidence: string[];
  /** Active time last spent in it, and when. */
  lastActiveAt: number;
  lastActiveMs: number;
}

interface History {
  /** from -> to -> count */
  transitions: Map<string, Map<string, number>>;
  /** key -> hour -> count */
  hours: Map<string, number[]>;
  /** key -> label, most recent wins */
  labels: Map<string, string>;
  lastSeen: Map<string, { at: number; activeMs: number }>;
  totalTransitions: number;
}

function buildHistory(days: WorkDay[], tzOffsetMinutes: number): History {
  const transitions = new Map<string, Map<string, number>>();
  const hours = new Map<string, number[]>();
  const labels = new Map<string, string>();
  const lastSeen = new Map<string, { at: number; activeMs: number }>();
  let totalTransitions = 0;

  for (const day of days) {
    const ordered = [...day.contexts].sort((a, b) => a.startTimestamp - b.startTimestamp);
    for (let i = 0; i < ordered.length; i += 1) {
      const c = ordered[i]!;
      const key = contextKey(c);
      labels.set(key, c.label);

      const previous = lastSeen.get(key);
      if (!previous || c.endTimestamp > previous.at) {
        lastSeen.set(key, { at: c.endTimestamp, activeMs: c.activeMs });
      }

      const byHour = hours.get(key) ?? new Array<number>(24).fill(0);
      byHour[hourOf(c.startTimestamp, tzOffsetMinutes)]! += 1;
      hours.set(key, byHour);

      // Only within a day. A context ending at 18:00 and one starting at 09:00 the next morning
      // are separated by a night, not by a decision.
      const next = ordered[i + 1];
      if (!next) continue;
      const to = contextKey(next);
      if (to === key) continue;
      const row = transitions.get(key) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + 1);
      transitions.set(key, row);
      totalTransitions += 1;
    }
  }

  return { transitions, hours, labels, lastSeen, totalTransitions };
}

/**
 * Rank what to pick up next.
 *
 * `from` is the context just left, if any; `atHour` is the local hour being predicted for. With no
 * usable history the result is empty rather than a guess — an empty panel is honest, and a confident
 * wrong one is not.
 */
export function suggestNext(
  days: WorkDay[],
  tzOffsetMinutes: number,
  options: { from?: string; atHour: number; limit?: number } = { atHour: 9 },
): Suggestion[] {
  const history = buildHistory(days, tzOffsetMinutes);
  if (history.totalTransitions < MIN_TRANSITIONS) return [];

  const candidates = new Set<string>([...history.labels.keys()]);
  if (options.from) candidates.delete(options.from);

  const out: Suggestion[] = [];
  for (const key of candidates) {
    const evidence: string[] = [];

    // Transition evidence: of the times you left `from`, how often you came here.
    let transitionScore = 0;
    if (options.from) {
      const row = history.transitions.get(options.from);
      const total = row ? [...row.values()].reduce((sum, v) => sum + v, 0) : 0;
      const count = row?.get(key) ?? 0;
      if (total > 0 && count > 0) {
        transitionScore = count / total;
        evidence.push(
          `${count} fois sur ${total} après « ${history.labels.get(options.from) ?? options.from} »`,
        );
      }
    }

    // Hour evidence: how much of this context's history sits in this hour, and the two around it.
    const byHour = history.hours.get(key) ?? [];
    const total = byHour.reduce((sum, v) => sum + v, 0);
    let hourScore = 0;
    if (total > 0) {
      const near =
        (byHour[(options.atHour + 23) % 24] ?? 0) +
        (byHour[options.atHour] ?? 0) +
        (byHour[(options.atHour + 1) % 24] ?? 0);
      hourScore = near / total;
      if (near > 0) evidence.push(`${near} fois sur ${total} vers ${options.atHour} h`);
    }

    // Both must hold. A floor keeps a context with strong hour evidence but no observed transition
    // in the running, without letting it outrank one that has both.
    const score = Math.max(transitionScore, 0.15) * Math.max(hourScore, 0.15);
    if (evidence.length === 0) continue;

    const seen = history.lastSeen.get(key);
    out.push({
      key,
      label: history.labels.get(key) ?? key,
      score,
      evidence,
      lastActiveAt: seen?.at ?? 0,
      lastActiveMs: seen?.activeMs ?? 0,
    });
  }

  out.sort((a, b) => b.score - a.score || b.lastActiveAt - a.lastActiveAt);
  return out.slice(0, options.limit ?? 3);
}
