/**
 * Ask — a question in plain language, answered from the events on this machine.
 *
 * This is the promise the product is named for: come back tomorrow, next week or six months later
 * and ask *what was I working on*, *where was that page*, *why did I touch this file* — and get the
 * answer with the evidence behind it. Everything here is local, deterministic and untrained. There
 * is no index to warm, no model to load, no key to configure and nothing to send anywhere (ADR 0005
 * D-13), which is also why every claim it makes can carry the event it was read from.
 *
 * The rule the whole module is built around is the one in SEARCH §7.3: **refuse rather than
 * approximate.** Below `MIN_ANSWER_SCORE` Ask says it did not find enough, shows the closest things
 * it did find, and stops. A memory tool that answers confidently from thin evidence is worse than
 * one that answers nothing, because the reader cannot tell the two apart until they act on it.
 *
 * Two entry points, on purpose:
 *
 *   `prepare(session)`  folds a day of events into a searchable corpus. Costs work; do it once.
 *   `ask(corpus, q)`    answers. Runs on every keystroke, so it never touches the engine.
 */

import type { GoldenSession } from '@rewind/fixtures/authoring';
import type { EngineContext } from '@rewind/engine-v0';

import { classify, type Classification, type Intent } from './intent.js';
import { scopeOf } from './kinds.js';
import { MIN_ANSWER_SCORE, rank, type Scored } from './rank.js';
import { buildCorpus, type Corpus, type Row } from './rows.js';
import { terms as queryTerms, tokenize } from './text.js';
import { resolveTime, type TimeWindow } from './time.js';

export * from './intent.js';
export * from './kinds.js';
export * from './rank.js';
export * from './rows.js';
export * from './text.js';
export * from './time.js';

/** A context, summarised over the window the question asked about. */
export interface Rollup {
  contextId: string;
  label: string;
  labelIsFallback: boolean;
  place: EngineContext['place'];
  startTimestamp: number;
  endTimestamp: number;
  activeMs: number;
  eventCount: number;
  appChain: string[];
  /** The rows worth naming: what was edited, run, committed, read. */
  highlights: Row[];
  /** Best row score inside this context, so a question can order contexts by relevance. */
  score: number;
}

export type RefusalReason =
  /** Nothing in the corpus matched at all. */
  | 'no_match'
  /** Something matched, but not well enough to call it an answer. */
  | 'below_threshold'
  /** A "why" question with only one source. One event is a coincidence, not a cause. */
  | 'insufficient_evidence'
  /** The window resolved fine and there is simply nothing in it. */
  | 'empty_window';

export interface Refusal {
  reason: RefusalReason;
  /** What was found anyway, best first. Shown under the refusal — never presented as the answer. */
  closest: Scored[];
}

export interface Answer {
  query: string;
  intent: Intent;
  /** The words that decided the intent, so the interface can show its reasoning. */
  because: string;
  /** What was actually searched for, after the time expression and the question words came out. */
  terms: string[];
  window: TimeWindow | null;
  /** Ranked rows, best first. Empty when Ask refuses. */
  results: Scored[];
  /** Contexts over the window — the answer's shape for `temporal` and `summary` questions. */
  rollup: Rollup[];
  /** The context to open, for `resume` and `navigation`. */
  contextId: string | null;
  refusal: Refusal | null;
}

/** How many ranked rows are worth showing. Past this, nobody is reading. */
const MAX_RESULTS = 24;

/** Fold a session into the searchable corpus. Costs an engine run; memoise it on the session. */
export function prepare(session: GoldenSession): Corpus {
  return buildCorpus(session);
}

/**
 * Strip the parts of the question that are not what is being searched for.
 *
 * "qu'est-ce que j'ai fait vendredi après-midi sur stripe" searches for `stripe`. Leaving `vendredi`
 * in the terms is not harmless: it is a rare token, so IDF hands it most of the question's weight,
 * and the top result becomes whichever row happens to contain the word Friday.
 */
function contentTerms(query: string, window: TimeWindow | null, because: string): string[] {
  // Removing tokens rather than cutting substrings out of the query. Both sides then go through the
  // same tokeniser, so accents and apostrophes cannot make a phrase fail to match itself — which is
  // exactly what happened when the classifier's folded "ou etait" was searched for in a raw "où
  // était".
  const drop = new Set(tokenize(window?.expression ?? ''));
  // `default` and `time` are how the classifier reports that no phrase decided the intent. They are
  // not words from the question, and dropping them would quietly delete a real term from a query
  // about, say, a default timeout.
  if (because !== 'default' && because !== 'time') {
    for (const token of tokenize(because)) drop.add(token);
  }
  return queryTerms(query).filter((term) => !drop.has(term));
}

function rollupOf(corpus: Corpus, window: TimeWindow | null, scored: Scored[]): Rollup[] {
  const best = new Map<string, number>();
  const highlights = new Map<string, Row[]>();
  for (const { row, score } of scored) {
    if (!row.contextId) continue;
    best.set(row.contextId, Math.max(best.get(row.contextId) ?? 0, score));
    const list = highlights.get(row.contextId) ?? [];
    // A window row is what the reader already saw; the interesting highlights are the things they
    // did. Titles are kept only when a context produced nothing else.
    if (list.length < 6 && (row.kind !== 'window' || list.length === 0)) list.push(row);
    highlights.set(row.contextId, list);
  }

  const out: Rollup[] = [];
  for (const context of corpus.contexts) {
    const overlaps =
      !window || (context.startTimestamp < window.to && context.endTimestamp >= window.from);
    if (window?.hard && !overlaps) continue;
    out.push({
      contextId: context.id,
      label: context.label,
      labelIsFallback: context.labelIsFallback,
      place: context.place,
      startTimestamp: context.startTimestamp,
      endTimestamp: context.endTimestamp,
      activeMs: context.activeMs,
      eventCount: context.eventRefs.length,
      appChain: context.appChain,
      highlights: highlights.get(context.id) ?? [],
      score: best.get(context.id) ?? 0,
    });
  }
  return out;
}

/**
 * Answer a question.
 *
 * `now` is a parameter rather than a call to the clock so that the whole thing stays a pure function
 * of its inputs — which is what lets the tests pin "vendredi dernier" to a known Wednesday, and what
 * makes a replayed fixture behave exactly like a live capture.
 */
export function ask(corpus: Corpus, query: string, now: number = Date.now()): Answer {
  const tz = corpus.tzOffsetMinutes;
  const window = resolveTime(query, now, tz, { lunchHour: corpus.lunchHour });
  const classification: Classification = classify(query, window !== null);
  const scope = scopeOf(query);
  const terms = contentTerms(query, window, classification.because).filter(
    (term) => !scope.words.has(term),
  );

  const options = { terms, window, now, contextTokens: corpus.contextTokens };
  let scored = rank(corpus.rows, { ...options, kinds: scope.kinds });
  // The category was a hint, not a constraint. Someone who said "fichier" while the answer is a
  // commit message is better served by the commit than by nothing at all.
  if (scored.length === 0 && scope.kinds.size > 0) scored = rank(corpus.rows, options);

  // With no content terms the question is entirely about a time or a category — "hier", "quelle
  // commande a échoué". Nothing can score on relevance, so ranking falls back to recency and
  // importance, and the answer is what is in the window rather than a relevance list. Applying the
  // relevance threshold here would refuse to answer a question that was perfectly clear.
  const askedAboutTime = terms.length === 0;
  const rollup = rollupOf(corpus, window, scored);
  const answer: Answer = {
    query,
    intent: classification.intent,
    because: classification.because,
    terms,
    window,
    results: [],
    rollup: [],
    contextId: null,
    refusal: null,
  };

  if (askedAboutTime) {
    if (rollup.length === 0 && scored.length === 0) {
      return { ...answer, refusal: { reason: 'empty_window', closest: [] } };
    }
    const ordered = [...rollup].sort((a, b) => b.endTimestamp - a.endTimestamp);
    return {
      ...answer,
      results: scored.slice(0, MAX_RESULTS),
      rollup: ordered,
      contextId: ordered[0]?.contextId ?? null,
    };
  }

  // Rows that neither match the question nor sit in a context that does are not results; they are
  // the rest of the corpus, sorted. Keeping them would make an empty answer look like a full one.
  const relevant = scored.filter((s) => s.parts.lexical > 0 || s.parts.affinity > 0);
  const top = relevant[0];

  if (!top) return { ...answer, refusal: { reason: 'no_match', closest: scored.slice(0, 3) } };
  if (top.score < MIN_ANSWER_SCORE) {
    return { ...answer, refusal: { reason: 'below_threshold', closest: relevant.slice(0, 3) } };
  }

  // "Why does this exist" answered from a single event is a guess dressed as a cause. Two
  // independent sources, or it says so (SEARCH §7.3).
  if (classification.intent === 'causal') {
    const sources = new Set(relevant.filter((s) => s.parts.lexical > 0).map((s) => s.row.key));
    if (sources.size < 2) {
      return {
        ...answer,
        refusal: { reason: 'insufficient_evidence', closest: relevant.slice(0, 3) },
      };
    }
  }

  const results = relevant.slice(0, MAX_RESULTS);
  const byRelevance = [...rollupOf(corpus, window, results)].sort((a, b) => b.score - a.score);

  return {
    ...answer,
    results,
    rollup: byRelevance,
    contextId:
      classification.intent === 'resume'
        ? (rollup.sort((a, b) => b.endTimestamp - a.endTimestamp)[0]?.contextId ?? null)
        : (byRelevance[0]?.contextId ?? top.row.contextId),
  };
}
