/**
 * Have you drifted off what you were doing?
 *
 * This is the only prediction that could interrupt someone, so it is the one held to the highest
 * bar. The rule throughout: it reports, it never nags. It answers a question the window can display
 * quietly — "you are no longer on the thing you were on" — and it says how long, so the reader
 * decides whether that was deliberate.
 *
 * It refuses to speak when it cannot be sure, and there are three ways it cannot be sure:
 *
 *   - the current stretch carries no identity, so there is nothing to compare;
 *   - the drift is shorter than a normal excursion, and normal is measured from your own history
 *     rather than assumed;
 *   - there was no established context to drift from in the first place.
 *
 * The threshold is your own median return time, not a constant. Someone who habitually dips out for
 * two minutes should not be told about a two-minute dip.
 */

import type { EngineContext } from '@rewind/engine-v0';

import { contextKey } from './days.js';
import type { InterruptionCost } from './interruption.js';

/** Used only when there is not enough history to measure a personal one. */
const FALLBACK_DRIFT_MS = 15 * 60 * 1000;
/** However short your history says, never report a drift below this. */
const FLOOR_MS = 5 * 60 * 1000;

export interface Drift {
  /** The context you were on. */
  fromLabel: string;
  /** What has been active since. Null when the current stretch has no name of its own. */
  toLabel: string | null;
  awayMs: number;
  /** The threshold this crossed, so the reader can judge the judgement. */
  thresholdMs: number;
  /** Whether history says you usually come back to this one. */
  usuallyReturns: boolean | null;
}

/**
 * Report a drift, or null.
 *
 * `contexts` is today, `now` is the instant being judged. The established context is the one with
 * the most active time that is not the current one — a five-minute visit is not a thread to be
 * dragged back to.
 */
export function detectDrift(
  contexts: EngineContext[],
  now: number,
  history: InterruptionCost,
): Drift | null {
  if (contexts.length < 2) return null;

  const ordered = [...contexts].sort((a, b) => a.endTimestamp - b.endTimestamp);
  const current = ordered[ordered.length - 1]!;
  const earlier = ordered.slice(0, -1);
  if (earlier.length === 0) return null;

  // The thread worth mentioning is the one you spent real time on, not merely the previous one.
  const established = earlier.reduce((best, c) => (c.activeMs > best.activeMs ? c : best));
  if (established.activeMs <= current.activeMs) return null;

  const awayMs = now - established.endTimestamp;

  // Your own median excursion, floored. Someone who dips out for two minutes routinely should never
  // be told about a two-minute dip.
  const thresholdMs = Math.max(FLOOR_MS, history.medianReturnMs ?? FALLBACK_DRIFT_MS);
  if (awayMs < thresholdMs) return null;

  const stats = history.byContext.get(contextKey(established));

  return {
    fromLabel: established.label,
    // A current stretch the engine could not name is reported as unnamed rather than as its
    // application: saying you drifted "to Chrome" states the tool, which is exactly the confusion
    // the whole product exists to avoid.
    toLabel: current.labelIsFallback ? null : current.label,
    awayMs,
    thresholdMs,
    usuallyReturns: stats ? stats.returns >= 2 : null,
  };
}
