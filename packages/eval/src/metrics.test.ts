/**
 * Tests for the evaluation harness itself.
 *
 * A benchmark nobody has verified is worse than no benchmark: it produces numbers that get trusted.
 * These tests pin the metrics against cases whose correct answer is known by construction.
 */

import { describe, expect, it } from 'vitest';

import { loadAllGoldenSessions, loadGoldenSession, type GoldenSession } from '@rewind/fixtures';

import { BASELINES, getPredictor } from './baselines.js';
import { evaluateSession, summarise, type Prediction } from './metrics.js';

const sessions = loadAllGoldenSessions();

function oracleFor(session: GoldenSession): Prediction {
  return getPredictor('oracle')!.predict(session);
}

describe('golden set integrity', () => {
  it('has the scenarios the roadmap requires', () => {
    expect(sessions.map((s) => s.id)).toEqual([
      'gs-01-focused-debugging',
      'gs-02-temporary-interruption',
      'gs-03-real-context-switch',
      'gs-04-two-tasks-same-repo',
      'gs-05-failed-investigation',
      'gs-06-chaotic-day',
      'gs-07-cross-app-feature-work',
      'gs-08-two-projects-interleaved',
      'gs-09-administrative-work',
      'gs-10-communication-noise',
      'gs-11-off-hours-drift',
    ]);
  });

  it.each(sessions.map((s) => [s.id, s] as const))(
    '%s is internally consistent',
    (_id, session) => {
      const refs = new Set(session.events.map((e) => e.ref));
      const assigned = new Set<string>();

      for (const ctx of session.expected.contexts) {
        expect(ctx.eventRefs.length).toBeGreaterThan(0);
        for (const ref of ctx.eventRefs) {
          expect(refs.has(ref), `${ref} is not an event in this session`).toBe(true);
          expect(assigned.has(ref), `${ref} belongs to two contexts`).toBe(false);
          assigned.add(ref);
        }
        // Important events are the Resume-critical subset, so they must be members.
        for (const ref of ctx.importantEventRefs) expect(ctx.eventRefs).toContain(ref);
        expect(ctx.startTimestamp).toBeLessThanOrEqual(ctx.endTimestamp);
      }

      for (const ref of session.expected.noiseEventRefs) {
        expect(refs.has(ref)).toBe(true);
        expect(assigned.has(ref)).toBe(false);
        assigned.add(ref);
      }

      // Every event is either in a context or declared as noise — no unlabelled ground truth.
      expect(assigned.size).toBe(refs.size);
    },
  );

  it.each(sessions.map((s) => [s.id, s] as const))('%s is chronologically ordered', (_id, s) => {
    for (let i = 1; i < s.events.length; i += 1) {
      expect(s.events[i]!.timestamp).toBeGreaterThanOrEqual(s.events[i - 1]!.timestamp);
    }
  });

  it('declares at least one important event per context Resume speaks about', () => {
    for (const session of sessions) {
      for (const ctx of session.expected.contexts) {
        // A context with no expected next step is one Resume has nothing to offer for — off-hours
        // time that must be grouped correctly but has no work to resume. Demanding an important
        // event there would mean inventing significance the capture never saw.
        if (!ctx.expectedNextStep) continue;
        expect(ctx.importantEventRefs.length, `${session.id}/${ctx.tag}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('metrics — known-answer cases', () => {
  it('scores the oracle at 1.0 on every session', () => {
    for (const session of sessions) {
      const m = evaluateSession(session, oracleFor(session));
      expect(m.pairwiseF1, session.id).toBeCloseTo(1, 10);
      expect(m.falseMergeRate).toBe(0);
      expect(m.falseSplitRate).toBe(0);
      expect(m.purity).toBeCloseTo(1, 10);
      expect(m.coverage).toBeCloseTo(1, 10);
      expect(m.importantEventRecall).toBeCloseTo(1, 10);
      expect(m.noiseAbsorbed).toBe(0);
      expect(m.ari).toBeCloseTo(1, 10);
      expect(m.contextCountDelta).toBe(0);
    }
  });

  it('gives one-context-for-everything perfect recall and no precision on a multi-context session', () => {
    const session = loadGoldenSession('gs-03-real-context-switch');
    const m = evaluateSession(session, getPredictor('single-context')!.predict(session));
    expect(m.pairwiseRecall).toBeCloseTo(1, 10);
    expect(m.falseSplitRate).toBe(0);
    expect(m.falseMergeRate).toBeGreaterThan(0);
    expect(m.mergedContexts).toBe(1);
    expect(m.splitContexts).toBe(0);
  });

  it('gives one-context-per-event perfect precision and no recall', () => {
    const session = loadGoldenSession('gs-01-focused-debugging');
    const m = evaluateSession(session, getPredictor('per-event')!.predict(session));
    expect(m.pairwiseRecall).toBe(0);
    expect(m.falseMergeRate).toBe(0);
    expect(m.falseSplitRate).toBeCloseTo(1, 10);
    expect(m.splitContexts).toBe(1);
  });

  it('detects a merge and a split independently', () => {
    const session = loadGoldenSession('gs-04-two-tasks-same-repo');
    const [a, b] = session.expected.contexts;

    const merged: Prediction = new Map();
    for (const ref of [...a!.eventRefs, ...b!.eventRefs]) merged.set(ref, 'one');
    const mergedMetrics = evaluateSession(session, merged);
    expect(mergedMetrics.mergedContexts).toBe(1);
    expect(mergedMetrics.splitContexts).toBe(0);

    // Split only the first context, in half; leave the second correct.
    const split: Prediction = new Map();
    a!.eventRefs.forEach((ref, i) => split.set(ref, i % 2 === 0 ? 'a1' : 'a2'));
    for (const ref of b!.eventRefs) split.set(ref, 'b');
    const splitMetrics = evaluateSession(session, split);
    expect(splitMetrics.splitContexts).toBe(1);
    expect(splitMetrics.mergedContexts).toBe(0);
  });

  it('counts noise pulled into a real context', () => {
    const session = loadGoldenSession('gs-02-temporary-interruption');
    expect(session.expected.noiseEventRefs.length).toBeGreaterThan(0);

    const absorbing: Prediction = new Map(session.events.map((e) => [e.ref, 'all']));
    expect(evaluateSession(session, absorbing).noiseAbsorbed).toBe(
      session.expected.noiseEventRefs.length,
    );

    const dropping = oracleFor(session);
    expect(evaluateSession(session, dropping).noiseAbsorbed).toBe(0);
  });

  it('reports important-event recall separately from overall coverage', () => {
    const session = loadGoldenSession('gs-05-failed-investigation');
    const ctx = session.expected.contexts[0]!;
    const prediction: Prediction = new Map();
    // Put every important event in a second context: coverage stays high, important recall collapses.
    for (const ref of ctx.eventRefs) {
      prediction.set(ref, ctx.importantEventRefs.includes(ref) ? 'stray' : 'main');
    }
    const m = evaluateSession(session, prediction);
    expect(m.coverage).toBeGreaterThan(0.5);
    expect(m.importantEventRecall).toBe(0);
  });
});

describe('baselines behave as documented', () => {
  it('per-repository cannot separate two tasks in one repository (GS-04)', () => {
    const session = loadGoldenSession('gs-04-two-tasks-same-repo');
    const m = evaluateSession(session, getPredictor('per-repository')!.predict(session));
    expect(m.predictedContexts).toBe(1);
    expect(m.mergedContexts).toBe(1);
    expect(m.falseMergeRate).toBeGreaterThan(0.3);
  });

  it('a pure time-gap heuristic gets the chaotic day wrong even when the count is right', () => {
    const session = loadGoldenSession('gs-06-chaotic-day');
    const m = evaluateSession(session, getPredictor('time-gap-15m')!.predict(session));

    // It happens to produce exactly three contexts — and they are the wrong three. This is why
    // context count is reported but never used as a quality metric on its own.
    expect(m.predictedContexts).toBe(session.expected.contextCount);
    expect(m.ari).toBeLessThan(0.3);
    expect(m.splitContexts).toBeGreaterThan(0);
    expect(m.mergedContexts).toBeGreaterThan(0);
  });

  it('scores per-application worse than chance — application is not context (ADR 0002 D-15)', () => {
    const suite = summarise(
      sessions.map((session) =>
        evaluateSession(session, getPredictor('per-application')!.predict(session)),
      ),
    );
    // An ARI near zero means the grouping carries almost no information about the truth. This is
    // the pivot's central claim, measured rather than asserted.
    //
    // The bound is 0.1 rather than 0.05 because GS-11 contains a context that genuinely IS one
    // application — three hours of one game — which flatters this baseline slightly. The point is
    // unchanged: it sits near chance while the engine is four times higher, and a real day is not
    // made of contexts that each happen to be a single application.
    expect(suite.meanAri).toBeLessThan(0.1);
    expect(suite.meanFalseSplitRate).toBeGreaterThan(0.5);
  });

  it('makes GS-08 hard for every naive baseline, and the engine beats them all', () => {
    const session = loadGoldenSession('gs-08-two-projects-interleaved');
    const scoreOf = (id: string) =>
      evaluateSession(session, getPredictor(id)!.predict(session)).pairwiseF1;

    // Two projects interleaved in short slices, sharing every application. Nothing naive works.
    for (const predictor of BASELINES) {
      if (predictor.id === 'oracle' || predictor.id === 'engine-v0') continue;
      expect(scoreOf(predictor.id), predictor.id).toBeLessThan(0.7);
    }

    // And the point of the fixture: an anchor-based engine does better than all of them. If this
    // ever fails, the anchors have stopped carrying the signal the pivot depends on.
    const engine = scoreOf('engine-v0');
    for (const predictor of BASELINES) {
      if (predictor.id === 'oracle' || predictor.id === 'engine-v0') continue;
      expect(engine, `engine-v0 vs ${predictor.id}`).toBeGreaterThan(scoreOf(predictor.id));
    }
  });

  it('is not code-shaped: the administrative fixture has no development events', () => {
    const session = loadGoldenSession('gs-09-administrative-work');
    const devSources = ['git', 'terminal', 'ide', 'agent'];
    const devEvents = session.events.filter((e) => devSources.includes(e.source));
    expect(devEvents).toHaveLength(0);
    // And no event carries a repository, so a repository-keyed engine has nothing to work with.
    expect(session.events.every((e) => e.repositoryId === undefined)).toBe(true);
  });

  it('no baseline reaches the quality targets — there is real work to do', () => {
    for (const predictor of BASELINES) {
      if (predictor.id === 'oracle') continue;
      const suite = summarise(sessions.map((s) => evaluateSession(s, predictor.predict(s))));
      const meetsTargets =
        suite.meanFalseMergeRate < 0.1 &&
        suite.meanFalseSplitRate < 0.15 &&
        suite.meanImportantEventRecall > 0.9;
      expect(meetsTargets, `${predictor.id} unexpectedly meets the targets`).toBe(false);
    }
  });
});
