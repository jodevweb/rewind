/**
 * Context engine evaluation CLI (ticket P0-005).
 *
 *   pnpm eval                       score every baseline against the whole golden set
 *   pnpm eval --predictor time-gap-15m
 *   pnpm eval --session gs-04-two-tasks-same-repo --detail
 *   pnpm eval --predictions out.json     score an external engine (the Rust one, later)
 *
 * The prediction file format is deliberately trivial so any engine can emit it:
 *   { "gs-04-two-tasks-same-repo": { "gs-04-...-e001": "ctx-a", "gs-04-...-e002": null } }
 */

import { readFileSync } from 'node:fs';

import { loadAllGoldenSessions, type GoldenSession } from '@rewind/fixtures';

import { BASELINES, getPredictor, type Predictor } from './baselines.js';
import { evaluateSession, summarise, type Prediction, type SessionMetrics } from './metrics.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name: string) => args.includes(`--${name}`);

const pct = (v: number) => `${(v * 100).toFixed(1).padStart(5)}%`;
const bar = (v: number, width = 12) => {
  const filled = Math.round(Math.max(0, Math.min(1, v)) * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
};

function loadExternalPredictions(path: string): Predictor {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    Record<string, string | null>
  >;
  return {
    id: `file:${path}`,
    description: 'External predictions',
    predict: (session) => new Map(Object.entries(raw[session.id] ?? {})),
  };
}

function run(predictor: Predictor, sessions: GoldenSession[]): SessionMetrics[] {
  return sessions.map((s) => evaluateSession(s, predictor.predict(s) as Prediction));
}

function printDetail(predictor: Predictor, metrics: SessionMetrics[]): void {
  console.log(`\n${predictor.id} — ${predictor.description}\n`);
  for (const m of metrics) {
    const delta = m.contextCountDelta;
    const deltaLabel =
      delta === 0 ? 'exact' : delta > 0 ? `+${delta} fragmented` : `${delta} over-merged`;
    console.log(`  ${m.sessionId}  (${m.sessionName})`);
    console.log(
      `    contexts     ${m.predictedContexts} predicted vs ${m.expectedContexts} expected  (${deltaLabel})`,
    );
    console.log(
      `    pairwise     F1 ${pct(m.pairwiseF1)}   precision ${pct(m.pairwisePrecision)}   recall ${pct(m.pairwiseRecall)}`,
    );
    console.log(
      `    errors       false merge ${pct(m.falseMergeRate)}   false split ${pct(m.falseSplitRate)}`,
    );
    console.log(`    purity       ${pct(m.purity)}   coverage ${pct(m.coverage)}`);
    console.log(
      `    important    ${pct(m.importantEventRecall)}   noise absorbed ${m.noiseAbsorbed}/${m.noiseEventCount}`,
    );
    console.log(
      `    context errs merged ${m.mergedContexts}   split ${m.splitContexts}   ARI ${m.ari.toFixed(3)}`,
    );
    for (const match of m.matches) {
      console.log(
        `      · ${match.truthLabel.padEnd(38)} ` +
          `cover ${pct(match.coverage)}  pure ${pct(match.purity)}  ` +
          `important ${pct(match.importantRecall)}`,
      );
    }
    console.log('');
  }
}

function main(): void {
  const all = loadAllGoldenSessions();
  const sessionFilter = flag('session');
  const sessions = sessionFilter ? all.filter((s) => s.id.includes(sessionFilter)) : all;

  if (sessions.length === 0) {
    console.error(`No golden session matches "${sessionFilter}"`);
    process.exit(1);
  }

  const predictionsPath = flag('predictions');
  const predictorId = flag('predictor');
  let predictors: Predictor[];

  if (predictionsPath) {
    predictors = [loadExternalPredictions(predictionsPath)];
  } else if (predictorId) {
    const p = getPredictor(predictorId);
    if (!p) {
      console.error(
        `Unknown predictor "${predictorId}". Known: ${BASELINES.map((b) => b.id).join(', ')}`,
      );
      process.exit(1);
    }
    predictors = [p];
  } else {
    predictors = BASELINES;
  }

  console.log(
    `\nContext engine benchmark — ${sessions.length} golden session(s), ` +
      `${sessions.reduce((n, s) => n + s.events.length, 0)} events, ` +
      `${sessions.reduce((n, s) => n + s.expected.contextCount, 0)} ground-truth contexts\n`,
  );

  const rows: { predictor: Predictor; metrics: SessionMetrics[] }[] = [];
  for (const p of predictors) rows.push({ predictor: p, metrics: run(p, sessions) });

  if (has('detail')) {
    for (const row of rows) printDetail(row.predictor, row.metrics);
  }

  console.log(
    '  predictor              pairwise F1     false merge   false split   purity   coverage   important   ARI',
  );
  console.log('  ' + '─'.repeat(108));
  for (const { predictor, metrics } of rows) {
    const s = summarise(metrics);
    console.log(
      `  ${predictor.id.padEnd(22)} ${bar(s.meanPairwiseF1)} ${pct(s.meanPairwiseF1)}   ` +
        `${pct(s.meanFalseMergeRate)}       ${pct(s.meanFalseSplitRate)}      ` +
        `${pct(s.meanPurity)}   ${pct(s.meanCoverage)}     ${pct(s.meanImportantEventRecall)}   ` +
        `${s.meanAri.toFixed(3)}`,
    );
  }

  console.log(
    '\n  Targets (PRODUCT.md §10.2): false merge < 10 %, false split < 15 %, important recall > 90 %.',
  );
  console.log(
    '  `oracle` must read 100 % — it scores the ground truth against itself and validates the harness.\n',
  );
}

main();
