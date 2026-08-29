/**
 * What Ask has to get right, and what it has to refuse.
 *
 * Two halves, and the second one matters more. The first checks that a question finds the thing it
 * is about. The second checks that a question about work that never happened finds *nothing* and
 * says so — because a memory that answers confidently from thin evidence is worse than one that
 * shrugs, and the reader cannot tell the two apart until they have already acted on the answer.
 *
 * Every test pins the clock. "Vendredi dernier" is a different window depending on the day it is
 * asked, and a temporal resolver tested against the real clock passes on Wednesdays.
 */

import { describe, expect, it } from 'vitest';

import { loadGoldenSession } from '@rewind/fixtures';
import type { GoldenSession } from '@rewind/fixtures/authoring';

import { ask, classify, prepare, resolveTime, MIN_ANSWER_SCORE, lunchHour } from './index.js';

const gs01 = loadGoldenSession('gs-01-focused-debugging');
const TZ = gs01.tzOffsetMinutes;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Local wall-clock helper: the moment `h:00` on a given day, in the session's timezone. */
const at = (year: number, month: number, day: number, h: number) =>
  Date.UTC(year, month - 1, day, h) - TZ * 60_000;

/** Local hour of a moment, in the session's timezone. */
const localHour = (ms: number) => new Date(ms + TZ * 60_000).getUTCHours();
const localDay = (ms: number) => new Date(ms + TZ * 60_000).toISOString().slice(0, 10);
const weekday = (ms: number) => new Date(ms + TZ * 60_000).getUTCDay();

describe('temporal resolution', () => {
  it('reads a work day as starting at 04:00, not at midnight', () => {
    // Asked at 01:30, "aujourd'hui" still means the day that began yesterday morning — which is how
    // the person who was awake at 01:30 remembers it, and what the store already does.
    const window = resolveTime("aujourd'hui", at(2026, 3, 12, 1) + 30 * 60_000, TZ)!;
    expect(window.hard).toBe(true);
    expect(localDay(window.from)).toBe('2026-03-11');
    expect(localHour(window.from)).toBe(4);
  });

  it('resolves a weekday to its most recent occurrence', () => {
    const window = resolveTime('vendredi', at(2026, 3, 12, 15), TZ)!;
    expect(weekday(window.from)).toBe(5);
    expect(window.from).toBeLessThan(at(2026, 3, 12, 15));
  });

  it('never reads "vendredi dernier" as today when today is a Friday', () => {
    const friday = resolveTime('vendredi', at(2026, 3, 12, 15), TZ)!.from;
    const onThatFriday = friday + 11 * HOUR;
    const window = resolveTime('vendredi dernier', onThatFriday, TZ)!;
    expect(localDay(window.from)).toBe(localDay(friday - 7 * DAY));
    expect(window.ambiguous).toBe(false);
  });

  it('declares the ambiguity of "vendredi dernier" said on a Saturday', () => {
    const friday = resolveTime('vendredi', at(2026, 3, 12, 15), TZ)!.from;
    const saturday = friday + DAY + 11 * HOUR;
    expect(resolveTime('vendredi dernier', saturday, TZ)!.ambiguous).toBe(true);
    // The same phrase mid-week has only one honest reading, so nothing is flagged.
    const wednesday = friday + 5 * DAY + 11 * HOUR;
    expect(resolveTime('vendredi dernier', wednesday, TZ)!.ambiguous).toBe(false);
  });

  it('narrows a day to a part of it', () => {
    const window = resolveTime('hier après-midi', at(2026, 3, 12, 15), TZ)!;
    expect(localDay(window.from)).toBe('2026-03-11');
    expect(localHour(window.from)).toBe(12);
    expect(localHour(window.to)).toBe(18);
  });

  it('lets the night cross midnight rather than stopping at it', () => {
    const window = resolveTime('cette nuit', at(2026, 3, 12, 15), TZ)!;
    expect(window.to - window.from).toBe(6 * HOUR);
    expect(localHour(window.from)).toBe(23);
  });

  it('resolves against the timezone the events carry, not the one the question is asked in', () => {
    // TR-8. The same words, the same instant, two offsets — two different windows. A flight between
    // the work and the question must not move the memory.
    const now = at(2026, 3, 12, 15);
    expect(resolveTime('hier', now, 60)!.from).not.toBe(resolveTime('hier', now, -480)!.from);
  });

  it('treats a vague expression as a boost and never as a filter', () => {
    const window = resolveTime('récemment', at(2026, 3, 12, 15), TZ)!;
    expect(window.hard).toBe(false);
  });

  it('reads a bare date as the most recent one that has already happened', () => {
    const past = resolveTime('12 mars', at(2026, 3, 20, 15), TZ)!;
    expect(localDay(past.from)).toBe('2026-03-12');
    // Asked in January, "12 mars" cannot mean a March that has not happened yet.
    const earlier = resolveTime('12 mars', at(2026, 1, 5, 15), TZ)!;
    expect(localDay(earlier.from)).toBe('2025-03-12');
  });

  it('says nothing about time when the question mentions none', () => {
    expect(resolveTime('la doc stripe', at(2026, 3, 12, 15), TZ)).toBeNull();
  });

  it('falls back to noon rather than inferring a lunch hour from one day', () => {
    expect(lunchHour({ events: [{ timestamp: 0 }], tzOffsetMinutes: TZ })).toBe(12);
  });

  it('counts the reader’s own lunch hour from their longest midday gap', () => {
    // Three days, each with work up to 11:00 and nothing again until 14:00.
    const events: { timestamp: number }[] = [];
    for (let d = 10; d < 13; d += 1) {
      events.push({ timestamp: at(2026, 3, d, 11) });
      events.push({ timestamp: at(2026, 3, d, 14) });
    }
    expect(lunchHour({ events, tzOffsetMinutes: TZ })).toBe(11);
  });
});

describe('intent', () => {
  const cases: [string, string][] = [
    ['sur quoi je travaillais ?', 'resume'],
    ['where was i', 'resume'],
    ['pourquoi j’ai touché ce fichier', 'causal'],
    ['why does this exist', 'causal'],
    ['ouvre le contexte stripe', 'navigation'],
    ['trouve la doc stripe', 'retrieval'],
    ['récapitulatif de la semaine', 'summary'],
    ['compare avec la dernière fois', 'comparison'],
    ['stripe.webhook.ts', 'retrieval'],
  ];
  for (const [query, intent] of cases) {
    it(`reads "${query}" as ${intent}`, () => {
      expect(classify(query, false).intent).toBe(intent);
    });
  }

  it('reads a date plus an action verb as a question about that window', () => {
    expect(classify("qu'est-ce que j'ai fait hier", true).intent).toBe('temporal');
  });

  it('reads a bare date as a request for that window’s rollup', () => {
    expect(classify('hier', true).intent).toBe('summary');
  });
});

/** The session's own last moment, so "now" is inside the day the fixture describes. */
const endOf = (session: GoldenSession) =>
  Math.max(...session.events.map((e) => e.endTimestamp ?? e.timestamp)) + 60_000;

describe('ask, over a real golden session', () => {
  const corpus = prepare(gs01);
  const now = endOf(gs01);

  it('finds the documentation the question is about', () => {
    const answer = ask(corpus, 'où était la doc stripe sur les invoices', now);
    expect(answer.refusal).toBeNull();
    expect(answer.results[0]!.row.target).toContain('stripe.com/docs');
  });

  it('finds the command that failed', () => {
    const answer = ask(corpus, 'quelle commande a échoué', now);
    expect(answer.refusal).toBeNull();
    // The failing test run is what "échoué" means here, and it is a row of its own kind.
    expect(answer.results.some((r) => r.row.kind === 'error')).toBe(true);
  });

  it('answers "sur quoi je travaillais" with the context, not with a list of rows', () => {
    const answer = ask(corpus, 'sur quoi je travaillais ?', now);
    expect(answer.intent).toBe('resume');
    expect(answer.refusal).toBeNull();
    expect(answer.contextId).not.toBeNull();
    const named = answer.rollup.find((r) => r.contextId === answer.contextId)!;
    expect(named.label).toMatch(/stripe|renewal|DNM-3921/i);
  });

  it('rolls a window up by context when the question is only about time', () => {
    const answer = ask(corpus, 'hier', now + DAY);
    expect(answer.intent).toBe('summary');
    expect(answer.rollup.length).toBeGreaterThan(0);
    expect(answer.rollup[0]!.activeMs).toBeGreaterThan(0);
  });

  it('keeps the question out of the search terms', () => {
    const answer = ask(corpus, "qu'est-ce que j'ai fait hier sur stripe", now);
    expect(answer.terms).toContain('stripe');
    expect(answer.terms).not.toContain('hier');
    expect(answer.terms).not.toContain('fait');
  });

  it('is a pure function of its inputs', () => {
    const a = ask(corpus, 'stripe webhook', now);
    const b = ask(corpus, 'stripe webhook', now);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('refusal', () => {
  const corpus = prepare(gs01);
  const now = endOf(gs01);

  it('refuses a question about work that never happened', () => {
    const answer = ask(corpus, 'la migration kubernetes vers gcp', now);
    expect(answer.refusal).not.toBeNull();
    expect(answer.results).toHaveLength(0);
  });

  it('never invents a cause from a single source', () => {
    // One event mentioning a thing is a coincidence. A cause needs at least two.
    const answer = ask(corpus, 'pourquoi zzzunmatchable', now);
    expect(answer.refusal).not.toBeNull();
  });

  it('shows what it did find instead of pretending it found nothing at all', () => {
    const answer = ask(corpus, 'kubernetes stripe', now);
    if (answer.refusal) expect(answer.refusal.closest.length).toBeGreaterThan(0);
  });

  it('holds the threshold it publishes', () => {
    const answer = ask(corpus, 'stripe', now);
    if (!answer.refusal) {
      expect(answer.results[0]!.score).toBeGreaterThanOrEqual(MIN_ANSWER_SCORE);
    }
  });

  it('says the window is empty rather than reaching outside it', () => {
    // A window years before anything was captured. The honest answer is that there is nothing there,
    // not the nearest thing that happened to exist.
    const answer = ask(corpus, 'hier', gs01.events[0]!.timestamp - 400 * DAY);
    expect(answer.refusal?.reason).toBe('empty_window');
  });
});

describe('privacy', () => {
  const now = endOf(gs01);

  /** The same session with one URL event marked private. */
  const withPrivate: GoldenSession = {
    ...gs01,
    events: gs01.events.map((e) =>
      typeof e.metadata['url'] === 'string' &&
      (e.metadata['url'] as string).includes('stripe.com/docs/api/invoices')
        ? { ...e, privacyLevel: 'private' as const }
        : e,
    ),
  };

  it('keeps private material out of a loose match', () => {
    const answer = ask(prepare(withPrivate), 'la doc de facturation', now);
    for (const result of answer.results) {
      expect(result.row.target ?? '').not.toContain('stripe.com/docs/api/invoices');
    }
  });

  it('still returns private material to a question that names it exactly', () => {
    const answer = ask(prepare(withPrivate), 'stripe.com/docs/api/invoices', now);
    expect(answer.results.some((r) => (r.row.target ?? '').includes('api/invoices'))).toBe(true);
  });
});
