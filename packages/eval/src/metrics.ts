/**
 * Context engine evaluation metrics (ticket P0-005).
 *
 * Deliberately decoupled from any engine: the input is a *prediction* — a map from event ref to a
 * predicted context id — so the same harness scores the TypeScript baselines today and the Rust
 * engine later, with no second implementation of the metrics.
 *
 * The goal is not a perfect score. It is a stable benchmark that makes a heuristic change
 * measurable instead of arguable.
 */

import type { GoldenSession } from '@rewind/fixtures';

/** `null` means the engine assigned the event to no context (dropped it as noise). */
export type Prediction = Map<string, string | null>;

export interface ContextMatch {
  truthTag: string;
  truthLabel: string;
  truthSize: number;
  predictedId: string | null;
  predictedSize: number;
  overlap: number;
  /** Of the matched predicted context, how much of it really belongs to this truth context. */
  purity: number;
  /** Of this truth context, how much the matched predicted context recovered. */
  coverage: number;
  importantRecall: number;
}

export interface SessionMetrics {
  sessionId: string;
  sessionName: string;

  truthEventCount: number;
  noiseEventCount: number;
  expectedContexts: number;
  predictedContexts: number;
  /** Predicted minus expected. Positive is fragmentation, negative is over-merging. */
  contextCountDelta: number;

  // ── Pairwise grouping: for two events that belong together, are they together? ──
  pairwisePrecision: number;
  pairwiseRecall: number;
  pairwiseF1: number;
  /** Of the pairs we grouped, the share that should not have been. */
  falseMergeRate: number;
  /** Of the pairs that belong together, the share we separated. */
  falseSplitRate: number;

  // ── Context-level ──
  /** Share of a predicted context's events that really belong to its dominant truth context. */
  purity: number;
  /** Share of a truth context's events recovered by its best-matching predicted context. */
  coverage: number;
  /** Predicted contexts spanning two or more truth contexts non-trivially. */
  mergedContexts: number;
  /** Truth contexts spread over two or more predicted contexts non-trivially. */
  splitContexts: number;

  /** Share of Resume-critical events landing in the right context. */
  importantEventRecall: number;
  /** Noise events pulled into a real context. Lower is better. */
  noiseAbsorbed: number;
  /** Adjusted Rand Index — a single chance-corrected agreement score. */
  ari: number;

  matches: ContextMatch[];
}

/**
 * A group counts as clean when its dominant component holds at least this share of it.
 *
 * Expressed as a tolerance rather than a "was any other piece material?" test, because the latter
 * misses total shattering: forty singletons contain no piece of two or more events, yet the context
 * is obviously fragmented. A share threshold catches both shattering and a genuine two-way split,
 * while forgiving one stray event.
 */
const DOMINANCE_TOLERANCE = 0.9;

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateSession(session: GoldenSession, prediction: Prediction): SessionMetrics {
  // Ground truth over non-noise events only. Noise is scored separately: an engine may legitimately
  // drop it or isolate it, and penalising both would encode a preference we have not decided.
  const truthOf = new Map<string, string>();
  for (const ctx of session.expected.contexts) {
    for (const ref of ctx.eventRefs) truthOf.set(ref, ctx.tag);
  }
  const noiseRefs = new Set(session.expected.noiseEventRefs);
  const refs = [...truthOf.keys()];

  // ── Pairwise ───────────────────────────────────────────────────────────────────────────────
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < refs.length; i += 1) {
    for (let j = i + 1; j < refs.length; j += 1) {
      const a = refs[i]!;
      const b = refs[j]!;
      const sameTruth = truthOf.get(a) === truthOf.get(b);
      const pa = prediction.get(a) ?? null;
      const pb = prediction.get(b) ?? null;
      const samePred = pa !== null && pa === pb;
      if (sameTruth && samePred) tp += 1;
      else if (!sameTruth && samePred) fp += 1;
      else if (sameTruth && !samePred) fn += 1;
    }
  }
  const pairwisePrecision = safeDiv(tp, tp + fp);
  const pairwiseRecall = safeDiv(tp, tp + fn);
  const pairwiseF1 = safeDiv(
    2 * pairwisePrecision * pairwiseRecall,
    pairwisePrecision + pairwiseRecall,
  );

  // ── Contingency table ──────────────────────────────────────────────────────────────────────
  const contingency = new Map<string, Map<string, number>>(); // predictedId -> truthTag -> count
  const predictedSizes = new Map<string, number>();
  for (const ref of refs) {
    const pid = prediction.get(ref) ?? null;
    if (pid === null) continue;
    const row = contingency.get(pid) ?? new Map<string, number>();
    const tag = truthOf.get(ref)!;
    row.set(tag, (row.get(tag) ?? 0) + 1);
    contingency.set(pid, row);
    predictedSizes.set(pid, (predictedSizes.get(pid) ?? 0) + 1);
  }

  // ── Purity (predicted side) and merge detection ────────────────────────────────────────────
  let purityHits = 0;
  let mergedContexts = 0;
  for (const [pid, row] of contingency) {
    const size = predictedSizes.get(pid)!;
    const dominant = Math.max(...row.values());
    purityHits += dominant;
    if (dominant / size < DOMINANCE_TOLERANCE) mergedContexts += 1;
  }
  const purity = safeDiv(purityHits, refs.length);

  // ── Coverage (truth side), split detection, and 1:1 matching ───────────────────────────────
  const matches: ContextMatch[] = [];
  let coverageHits = 0;
  let splitContexts = 0;
  let importantHits = 0;
  let importantTotal = 0;
  const claimed = new Set<string>();

  // Match greedily by overlap so each predicted context is attributed to at most one truth context.
  const candidates: { tag: string; pid: string; overlap: number }[] = [];
  for (const [pid, row] of contingency) {
    for (const [tag, n] of row) candidates.push({ tag, pid, overlap: n });
  }
  candidates.sort((a, b) => b.overlap - a.overlap);
  const bestForTag = new Map<string, { pid: string; overlap: number }>();
  for (const c of candidates) {
    if (bestForTag.has(c.tag) || claimed.has(c.pid)) continue;
    bestForTag.set(c.tag, { pid: c.pid, overlap: c.overlap });
    claimed.add(c.pid);
  }

  for (const ctx of session.expected.contexts) {
    const truthSize = ctx.eventRefs.length;
    const best = bestForTag.get(ctx.tag) ?? null;

    // Split detection uses the true distribution, not the matched pair.
    const spread = new Map<string, number>();
    for (const ref of ctx.eventRefs) {
      const pid = prediction.get(ref) ?? null;
      if (pid === null) continue;
      spread.set(pid, (spread.get(pid) ?? 0) + 1);
    }
    const largestPiece = spread.size === 0 ? 0 : Math.max(...spread.values());
    if (largestPiece / truthSize < DOMINANCE_TOLERANCE) splitContexts += 1;

    const overlap = best?.overlap ?? 0;
    coverageHits += overlap;

    const predictedSize = best ? (predictedSizes.get(best.pid) ?? 0) : 0;
    const importantInMatch = best
      ? ctx.importantEventRefs.filter((r) => (prediction.get(r) ?? null) === best.pid).length
      : 0;
    importantHits += importantInMatch;
    importantTotal += ctx.importantEventRefs.length;

    matches.push({
      truthTag: ctx.tag,
      truthLabel: ctx.label,
      truthSize,
      predictedId: best?.pid ?? null,
      predictedSize,
      overlap,
      purity: safeDiv(overlap, predictedSize),
      coverage: safeDiv(overlap, truthSize),
      importantRecall: safeDiv(importantInMatch, ctx.importantEventRefs.length),
    });
  }
  const coverage = safeDiv(coverageHits, refs.length);

  // ── Noise absorption ───────────────────────────────────────────────────────────────────────
  const realPredicted = new Set(contingency.keys());
  let noiseAbsorbed = 0;
  for (const ref of noiseRefs) {
    const pid = prediction.get(ref) ?? null;
    if (pid !== null && realPredicted.has(pid)) noiseAbsorbed += 1;
  }

  // ── Adjusted Rand Index ────────────────────────────────────────────────────────────────────
  const ari = adjustedRandIndex(refs, truthOf, prediction);

  const predictedContexts = new Set(
    [...prediction.entries()].filter(([, v]) => v !== null).map(([, v]) => v as string),
  ).size;

  return {
    sessionId: session.id,
    sessionName: session.name,
    truthEventCount: refs.length,
    noiseEventCount: noiseRefs.size,
    expectedContexts: session.expected.contextCount,
    predictedContexts,
    contextCountDelta: predictedContexts - session.expected.contextCount,
    pairwisePrecision,
    pairwiseRecall,
    pairwiseF1,
    falseMergeRate: safeDiv(fp, tp + fp),
    falseSplitRate: safeDiv(fn, tp + fn),
    purity,
    coverage,
    mergedContexts,
    splitContexts,
    importantEventRecall: safeDiv(importantHits, importantTotal),
    noiseAbsorbed,
    ari,
    matches,
  };
}

function choose2(n: number): number {
  return (n * (n - 1)) / 2;
}

function adjustedRandIndex(
  refs: string[],
  truthOf: Map<string, string>,
  prediction: Prediction,
): number {
  const table = new Map<string, number>();
  const rowSums = new Map<string, number>();
  const colSums = new Map<string, number>();

  for (const ref of refs) {
    const t = truthOf.get(ref)!;
    // Unassigned events become their own singleton cluster, which is what "dropped" means here.
    const p = prediction.get(ref) ?? `__unassigned__${ref}`;
    const key = `${t} ${p}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rowSums.set(t, (rowSums.get(t) ?? 0) + 1);
    colSums.set(p, (colSums.get(p) ?? 0) + 1);
  }

  const n = refs.length;
  if (n < 2) return 1;

  const sumCells = [...table.values()].reduce((acc, v) => acc + choose2(v), 0);
  const sumRows = [...rowSums.values()].reduce((acc, v) => acc + choose2(v), 0);
  const sumCols = [...colSums.values()].reduce((acc, v) => acc + choose2(v), 0);
  const total = choose2(n);

  const expected = (sumRows * sumCols) / total;
  const max = (sumRows + sumCols) / 2;
  return max === expected ? 1 : (sumCells - expected) / (max - expected);
}

export interface SuiteMetrics {
  sessions: SessionMetrics[];
  /** Unweighted means, so a big fixture cannot hide a failure on a small one. */
  meanPairwiseF1: number;
  meanFalseMergeRate: number;
  meanFalseSplitRate: number;
  meanPurity: number;
  meanCoverage: number;
  meanImportantEventRecall: number;
  meanAri: number;
  totalMergedContexts: number;
  totalSplitContexts: number;
  totalNoiseAbsorbed: number;
}

export function summarise(sessions: SessionMetrics[]): SuiteMetrics {
  const mean = (pick: (m: SessionMetrics) => number) =>
    sessions.length === 0 ? 0 : sessions.reduce((acc, m) => acc + pick(m), 0) / sessions.length;

  return {
    sessions,
    meanPairwiseF1: mean((m) => m.pairwiseF1),
    meanFalseMergeRate: mean((m) => m.falseMergeRate),
    meanFalseSplitRate: mean((m) => m.falseSplitRate),
    meanPurity: mean((m) => m.purity),
    meanCoverage: mean((m) => m.coverage),
    meanImportantEventRecall: mean((m) => m.importantEventRecall),
    meanAri: mean((m) => m.ari),
    totalMergedContexts: sessions.reduce((n, m) => n + m.mergedContexts, 0),
    totalSplitContexts: sessions.reduce((n, m) => n + m.splitContexts, 0),
    totalNoiseAbsorbed: sessions.reduce((n, m) => n + m.noiseAbsorbed, 0),
  };
}
