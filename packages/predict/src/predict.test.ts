/**
 * The property every one of these has to hold: silence rather than a guess.
 *
 * A prediction layer is easy to write and hard to trust. These tests are mostly about the refusals —
 * the cases where it must return nothing — because that is where a plausible-looking implementation
 * quietly starts inventing, and an invented number in this product is worse than a missing one.
 */

import { describe, expect, it } from 'vitest';

import { loadAllGoldenSessions, loadGoldenSession } from '@rewind/fixtures';
import type { GoldenSession } from '@rewind/fixtures/authoring';

import {
  detectDrift,
  interruptionCost,
  predict,
  rhythm,
  suggestNext,
  toWorkDays,
  workDay,
} from './index.js';

const sessions = loadAllGoldenSessions();
const gs06 = loadGoldenSession('gs-06-chaotic-day');
const gs11 = loadGoldenSession('gs-11-off-hours-drift');

/** The same session shifted forward by whole days, to synthesise history. */
function shiftDays(session: GoldenSession, dayCount: number): GoldenSession {
  const DAY = 86_400_000;
  return {
    ...session,
    events: session.events.map((e) => ({
      ...e,
      timestamp: e.timestamp + dayCount * DAY,
      ...(e.endTimestamp === undefined ? {} : { endTimestamp: e.endTimestamp + dayCount * DAY }),
    })),
  };
}

function withHistory(session: GoldenSession, days: number): GoldenSession {
  const events = [];
  for (let d = days - 1; d >= 0; d -= 1) events.push(...shiftDays(session, -d).events);
  return { ...session, events };
}

describe('work days', () => {
  it('puts the small hours with the previous day, like the store does', () => {
    // 01:30 belongs to the night before, which is how people remember it (INITIAL_ANALYSIS TR-8).
    const base = Date.UTC(2026, 7, 29, 1, 30);
    const later = Date.UTC(2026, 7, 29, 9, 30);
    expect(workDay(base, 0)).not.toBe(workDay(later, 0));
    expect(workDay(base, 0)).toBe('2026-08-28');
  });

  it('splits a multi-day stream and runs the engine per day', () => {
    const days = toWorkDays(withHistory(gs06, 4));
    expect(days).toHaveLength(4);
    for (const d of days) expect(d.contexts.length).toBeGreaterThan(0);
    // Each day is scored on its own, so the same day repeated yields the same context count.
    const counts = new Set(days.map((d) => d.contexts.length));
    expect(counts.size).toBe(1);
  });
});

describe('rhythm — counted, never modelled', () => {
  it('is a pure function of the events', () => {
    const a = rhythm(toWorkDays(gs06), gs06.tzOffsetMinutes);
    const b = rhythm(toWorkDays(gs06), gs06.tzOffsetMinutes);
    expect(a).toEqual(b);
  });

  it('never reports more active time than the day spans', () => {
    for (const session of sessions) {
      const days = toWorkDays(session);
      const r = rhythm(days, session.tzOffsetMinutes);
      for (const [i, day] of r.days.entries()) {
        const events = days[i]!.events;
        const span =
          Math.max(...events.map((e) => e.endTimestamp ?? e.timestamp)) -
          Math.min(...events.map((e) => e.timestamp));
        // Contexts do not overlap, so their active time cannot exceed the day they sit in. A
        // generous floor covers the engine's 30 s minimum per activity.
        expect(day.activeMs, `${session.id}/${day.day}`).toBeLessThanOrEqual(span + 60 * 60_000);
      }
    }
  });

  it('counts one switch fewer than it has contexts', () => {
    for (const session of sessions) {
      const r = rhythm(toWorkDays(session), session.tzOffsetMinutes);
      for (const day of r.days) {
        expect(day.switches, `${session.id}/${day.day}`).toBe(Math.max(0, day.contextCount - 1));
      }
    }
  });

  it('spreads active time over the hours a context spans, totalling what the day reports', () => {
    const r = rhythm(toWorkDays(gs06), gs06.tzOffsetMinutes);
    const fromHours = r.activeMsByHour.reduce((sum, v) => sum + v, 0);
    const fromDays = r.days.reduce((sum, d) => sum + d.activeMs, 0);
    // Rounding per hour costs a little; nothing else should.
    expect(Math.abs(fromHours - fromDays)).toBeLessThan(24 * 1000);
  });
});

describe('interruption cost — measured, and withheld when thin', () => {
  it('says nothing from too few observations', () => {
    // GS-09 is fourteen events of administrative work: nothing is left and resumed enough times to
    // support a median, and a median from one observation would be believed.
    const cost = interruptionCost(toWorkDays(loadGoldenSession('gs-09-administrative-work')));
    expect(cost.medianReturnMs).toBeNull();
  });

  it('only counts a return as a return when time actually passed', () => {
    for (const session of sessions) {
      const cost = interruptionCost(toWorkDays(session));
      for (const o of cost.observations) {
        expect(o.awayMs, `${session.id}/${o.key}`).toBeGreaterThan(0);
        expect(o.returnedAt).toBeGreaterThan(o.leftAt);
      }
    }
  });

  it('reports a per-context median only where there are several observations', () => {
    const cost = interruptionCost(toWorkDays(withHistory(gs06, 6)));
    for (const [, stats] of cost.byContext) {
      expect(stats.returns).toBeGreaterThanOrEqual(3);
      expect(stats.medianReturnMs).toBeGreaterThan(0);
    }
  });
});

describe('resume suggestions', () => {
  it('returns nothing without enough transitions', () => {
    const thin = loadGoldenSession('gs-01-focused-debugging');
    expect(suggestNext(toWorkDays(thin), thin.tzOffsetMinutes, { atHour: 10 })).toEqual([]);
  });

  it('carries the evidence for every suggestion it makes', () => {
    const session = withHistory(gs06, 5);
    const out = suggestNext(toWorkDays(session), session.tzOffsetMinutes, { atHour: 10 });
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.evidence.length, s.label).toBeGreaterThan(0);
      // Counted evidence, so every line has to contain a number.
      for (const line of s.evidence) expect(line).toMatch(/\d/);
    }
  });

  it('is ranked, and never suggests the context just left', () => {
    const session = withHistory(gs06, 5);
    const days = toWorkDays(session);
    const from = days[days.length - 1]!.contexts[0]!;
    const key = (from.labelIsFallback ? `app:${from.label}` : from.label).toLowerCase();
    const out = suggestNext(days, session.tzOffsetMinutes, { atHour: 14, from: key });
    expect(out.map((s) => s.key)).not.toContain(key);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i - 1]!.score).toBeGreaterThanOrEqual(out[i]!.score);
    }
  });

  it('is deterministic', () => {
    const session = withHistory(gs06, 5);
    const days = toWorkDays(session);
    const a = suggestNext(days, session.tzOffsetMinutes, { atHour: 11 });
    const b = suggestNext(days, session.tzOffsetMinutes, { atHour: 11 });
    expect(a).toEqual(b);
  });
});

describe('drift — the one that could interrupt, so the one that stays quiet', () => {
  const history = interruptionCost(toWorkDays(gs06));

  it('says nothing when there is only one context', () => {
    const days = toWorkDays(gs11);
    const one = [days[0]!.contexts[0]!];
    expect(detectDrift(one, one[0]!.endTimestamp + 60 * 60_000, history)).toBeNull();
  });

  it('says nothing before the threshold has passed', () => {
    const contexts = toWorkDays(gs06)[0]!.contexts;
    // A minute after leaving the ESTABLISHED context, not a minute after the last event of the day.
    // Measuring from the wrong end is how the first version of this test claimed a bug that was not
    // there: thirty-four minutes had genuinely passed, and the drift was correctly reported.
    const ordered = [...contexts].sort((a, b) => a.endTimestamp - b.endTimestamp);
    const established = ordered
      .slice(0, -1)
      .reduce((best, c) => (c.activeMs > best.activeMs ? c : best));
    expect(detectDrift(contexts, established.endTimestamp + 60_000, history)).toBeNull();
  });

  it('reports the threshold it used, so the judgement can be judged', () => {
    const contexts = toWorkDays(gs06)[0]!.contexts;
    const now = Math.max(...contexts.map((c) => c.endTimestamp)) + 4 * 60 * 60_000;
    const drift = detectDrift(contexts, now, history);
    if (drift) {
      expect(drift.thresholdMs).toBeGreaterThanOrEqual(5 * 60_000);
      expect(drift.awayMs).toBeGreaterThanOrEqual(drift.thresholdMs);
      expect(drift.fromLabel).not.toBe('');
    }
  });

  it('never names an unnamed stretch after its application', () => {
    // Saying you drifted "to Chrome" states the tool, which is the confusion the product exists to
    // avoid. An unnamed current stretch is reported as unnamed.
    for (const session of sessions) {
      const days = toWorkDays(session);
      for (const day of days) {
        const now = Math.max(0, ...day.contexts.map((c) => c.endTimestamp)) + 3 * 60 * 60_000;
        const drift = detectDrift(day.contexts, now, interruptionCost(days));
        if (!drift) continue;
        const current = [...day.contexts].sort((a, b) => a.endTimestamp - b.endTimestamp).pop()!;
        if (current.labelIsFallback) expect(drift.toLabel).toBeNull();
      }
    }
  });
});

describe('predict — the whole thing', () => {
  it('never reads the clock on its own', () => {
    const at = Date.UTC(2026, 7, 29, 12, 0);
    expect(predict(gs06, at)).toEqual(predict(gs06, at));
  });

  it('reports how much history it had, because that is the caveat', () => {
    expect(predict(withHistory(gs06, 7), Date.now()).daysOfHistory).toBe(7);
  });

  it('survives an empty session without inventing anything', () => {
    const empty: GoldenSession = { ...gs06, events: [] };
    const out = predict(empty, Date.now());
    expect(out.daysOfHistory).toBe(0);
    expect(out.suggestions).toEqual([]);
    expect(out.drift).toBeNull();
    expect(out.interruption.medianReturnMs).toBeNull();
  });

  it('runs on every golden session without throwing', () => {
    for (const session of sessions) {
      expect(() => predict(session, Date.now()), session.id).not.toThrow();
    }
  });
});
