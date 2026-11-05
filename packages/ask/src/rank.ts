/**
 * Ranking (SEARCH §6), and the reason the numbers differ from the ones in the document.
 *
 * The specification weights six signals, two of which do not exist yet on this machine: there is no
 * vector index (the `sqlite-vec` stage, 0.30) and no `ContextLink` graph to expand through (0.05).
 * The document says weights renormalise when a stage is unavailable, and the obvious reading —
 * spread the missing weight across everything left — is the wrong one here. Lexical matching is then
 * the *only* signal that reads the question at all, so spreading 0.30 across recency and importance
 * would let a recent, important, entirely unrelated row outrank an exact match from last week. That
 * is not a degraded search; it is a search that stopped answering the question.
 *
 * So the semantic weight goes to lexical, and the graph weight to context affinity, which is the
 * one-hop expansion this corpus can actually do:
 *
 *     0.55 lexical   0.20 contextAffinity   0.15 recency   0.10 sourceImportance
 *
 * Scores stay on an absolute 0–1 scale rather than being normalised against the best result in the
 * set. Normalising would make the top row score 1.0 even when nothing matched, and the refusal
 * threshold in §7.3 — the thing that stops this product inventing answers — would never fire.
 */

import type { Row } from './rows.js';
import { matches } from './text.js';
import type { TimeWindow } from './time.js';

export const WEIGHTS = {
  lexical: 0.55,
  affinity: 0.2,
  recency: 0.15,
  importance: 0.1,
} as const;

/** Below this, Ask says it does not know instead of answering (SEARCH §7.3). */
export const MIN_ANSWER_SCORE = 0.35;

/** Recency half-life. Fourteen days, the τ from §6. */
const TAU = 14 * 86_400_000;

export interface Scored {
  row: Row;
  score: number;
  /** Every term, kept so the interface can show why a row is here and a test can pin the reason. */
  parts: { lexical: number; affinity: number; recency: number; importance: number };
  /** Query terms this row actually matched. Highlighted in the interface. */
  matched: string[];
}

/**
 * Inverse document frequency over rows.
 *
 * Without it a query like "rewind auth" is dominated by `rewind`, which appears in every row on this
 * machine and therefore separates nothing. The rare term is the one carrying the question.
 */
function idfOf(rows: Row[], terms: string[]): Map<string, number> {
  const idf = new Map<string, number>();
  for (const term of terms) {
    let df = 0;
    for (const row of rows) {
      if (row.tokens.some((token) => matches(term, token))) df += 1;
    }
    idf.set(term, Math.log(1 + rows.length / (1 + df)));
  }
  return idf;
}

/** Fraction of the question's weight that a set of tokens covers. Absolute, 0–1. */
function coverage(
  tokens: string[],
  terms: string[],
  idf: Map<string, number>,
  total: number,
): { score: number; matched: string[] } {
  if (total === 0) return { score: 0, matched: [] };
  let sum = 0;
  const matched: string[] = [];
  for (const term of terms) {
    if (!tokens.some((token) => matches(term, token))) continue;
    sum += idf.get(term) ?? 0;
    matched.push(term);
  }
  return { score: sum / total, matched };
}

export interface RankOptions {
  terms: string[];
  window: TimeWindow | null;
  now: number;
  contextTokens: Map<string, string[]>;
  /** Row kinds the question named. Empty means every kind. */
  kinds?: Set<Row['kind']>;
}

/**
 * Score every row, filter by a hard window, and return them best first.
 *
 * A hard window removes rows; a soft one only boosts. That asymmetry is the single most important
 * rule in the temporal layer: an empty screen produced by over-reading "récemment" teaches the
 * reader that their data is not there, which is both false and hard to un-teach.
 */
export function rank(rows: Row[], options: RankOptions): Scored[] {
  const { terms, window, now, contextTokens, kinds } = options;
  const idf = idfOf(rows, terms);
  const total = terms.reduce((sum, term) => sum + (idf.get(term) ?? 0), 0);

  const out: Scored[] = [];
  for (const row of rows) {
    if (kinds && kinds.size > 0 && !kinds.has(row.kind)) continue;
    // Overlap, not containment: a context that started before the window and ran into it is part of
    // that afternoon, and a reader asking about the afternoon means it.
    const overlaps = !window || (row.firstAt < window.to && row.lastAt >= window.from);
    if (window?.hard && !overlaps) continue;

    const lexical = coverage(row.tokens, terms, idf, total);
    const affinity = row.contextId
      ? coverage(contextTokens.get(row.contextId) ?? [], terms, idf, total).score
      : 0;
    const recency = Math.exp(-Math.max(0, now - row.lastAt) / TAU);
    const importance = Math.min(1, row.importance / 100);

    let score =
      WEIGHTS.lexical * lexical.score +
      WEIGHTS.affinity * affinity +
      WEIGHTS.recency * recency +
      WEIGHTS.importance * importance;

    if (window && overlaps) score *= window.hard ? 1.25 : 1.2;

    // Sensitive material is not surfaced on a hunch: it needs the question to have actually named
    // it, not merely to have landed near it. Private material needs the whole question to match.
    if (row.privacyLevel === 'sensitive' && lexical.score < 1) score *= 0.6;
    if (row.privacyLevel === 'private' && lexical.score < 1) continue;

    out.push({
      row,
      score: Math.min(1, score),
      parts: { lexical: lexical.score, affinity, recency, importance },
      matched: lexical.matched,
    });
  }

  out.sort((a, b) => b.score - a.score || b.row.lastAt - a.row.lastAt);
  return out;
}
