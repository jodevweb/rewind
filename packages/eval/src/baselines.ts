/**
 * Baseline predictors.
 *
 * These are not the context engine. They exist so the benchmark has a floor and a ceiling on day
 * one, before any engine is written:
 *
 *   `oracle`          scores 1.0 by construction — it validates the metrics, not the engine
 *   `single-context`  perfect recall, no precision — what over-merging looks like
 *   `per-event`       perfect precision, no recall — what total fragmentation looks like
 *   `per-repository`  the intellectual shortcut GS-04 exists to punish
 *   `time-gap`        the naive heuristic most people reach for first
 *   `repo-and-gap`    a plausible V0, and the number the real engine must beat
 *
 * When the Rust engine lands it becomes another entry in this table. Any heuristic that cannot beat
 * `repo-and-gap` is not earning its complexity.
 */

import type { GoldenSession } from '@rewind/fixtures';

import type { Prediction } from './metrics.js';

export interface Predictor {
  id: string;
  description: string;
  predict: (session: GoldenSession) => Prediction;
}

const oracle: Predictor = {
  id: 'oracle',
  description: 'Ground truth. Validates the harness — must score 1.0 everywhere.',
  predict: (session) => {
    const out: Prediction = new Map();
    for (const ctx of session.expected.contexts) {
      for (const ref of ctx.eventRefs) out.set(ref, `truth:${ctx.tag}`);
    }
    for (const ref of session.expected.noiseEventRefs) out.set(ref, null);
    return out;
  },
};

const singleContext: Predictor = {
  id: 'single-context',
  description: 'Everything is one context. Maximal false merging.',
  predict: (session) => new Map(session.events.map((e) => [e.ref, 'all'])),
};

const perEvent: Predictor = {
  id: 'per-event',
  description: 'Every event is its own context. Maximal false splitting.',
  predict: (session) => new Map(session.events.map((e) => [e.ref, e.ref])),
};

const perRepository: Predictor = {
  id: 'per-repository',
  description: 'One context per repository. The shortcut GS-04 is designed to catch.',
  predict: (session) =>
    new Map(session.events.map((e) => [e.ref, `repo:${e.repositoryId ?? 'none'}`])),
};

const perApplication: Predictor = {
  id: 'per-application',
  description:
    'One context per application. ADR 0002 §17 says application switching is not context switching; this is the baseline that demonstrates it.',
  predict: (session) => new Map(session.events.map((e) => [e.ref, `app:${e.app ?? 'none'}`])),
};

function timeGapPredictor(gapMinutes: number): Predictor {
  return {
    id: `time-gap-${gapMinutes}m`,
    description: `A new context whenever ${gapMinutes} minutes pass with no event.`,
    predict: (session) => {
      const out: Prediction = new Map();
      let bucket = 0;
      let previousEnd: number | null = null;
      for (const e of session.events) {
        if (previousEnd !== null && e.timestamp - previousEnd > gapMinutes * 60_000) bucket += 1;
        out.set(e.ref, `gap:${bucket}`);
        previousEnd = Math.max(previousEnd ?? 0, e.endTimestamp ?? e.timestamp);
      }
      return out;
    },
  };
}

function repoAndGapPredictor(gapMinutes: number): Predictor {
  return {
    id: `repo-and-gap-${gapMinutes}m`,
    description: `A new context on a repository change or a ${gapMinutes}-minute gap. A plausible V0 — the number the real engine has to beat.`,
    predict: (session) => {
      const out: Prediction = new Map();
      let bucket = 0;
      let previousEnd: number | null = null;
      let previousRepo: string | null = null;
      for (const e of session.events) {
        const repo = e.repositoryId ?? null;
        const gapped = previousEnd !== null && e.timestamp - previousEnd > gapMinutes * 60_000;
        // A null repository (a browser tab, Slack) carries no signal, so it never forces a break.
        const switched = repo !== null && previousRepo !== null && repo !== previousRepo;
        if (gapped || switched) bucket += 1;
        out.set(e.ref, `rg:${bucket}`);
        previousEnd = Math.max(previousEnd ?? 0, e.endTimestamp ?? e.timestamp);
        if (repo !== null) previousRepo = repo;
      }
      return out;
    },
  };
}

export const BASELINES: Predictor[] = [
  oracle,
  singleContext,
  perEvent,
  perRepository,
  perApplication,
  timeGapPredictor(15),
  repoAndGapPredictor(15),
];

export function getPredictor(id: string): Predictor | undefined {
  return BASELINES.find((p) => p.id === id);
}
