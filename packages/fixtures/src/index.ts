/**
 * @rewind/fixtures — shared test data.
 *
 * Consumed by both languages: TypeScript imports it directly, Rust reads the same JSON from disk.
 * That is deliberate — a redaction corpus or a golden session that exists twice will diverge, and a
 * diverged privacy test is worse than no privacy test.
 *
 *   redaction/    positive.jsonl (must never be persisted) and negative.jsonl (must survive)
 *   golden/       generated from src/sessions — the ground truth for the context engine
 *   search-eval/  the frozen query set for retrieval scoring (SEARCH.md §10)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export * from './authoring.js';
export * from './event-shape.js';
export {
  ALL_SESSIONS,
  gs01,
  gs02,
  gs03,
  gs04,
  gs05,
  gs06,
  gs07,
  gs08,
  gs09,
  gs10,
} from './sessions/index.js';

import type { GoldenSession } from './authoring.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FIXTURE_ROOT = root;
export const REDACTION_DIR = join(root, 'redaction');
export const GOLDEN_DIR = join(root, 'golden');
export const SEARCH_EVAL_DIR = join(root, 'search-eval');

export interface RedactionPositiveCase {
  id: string;
  text: string;
  /** The raw secret. It must not appear anywhere in the output, or in the database. */
  mustNotContain: string;
  expectDetector: string;
}

export interface RedactionNegativeCase {
  id: string;
  text: string;
  /** Evidence the product depends on. Over-redaction here is as much a bug as under-redaction. */
  mustSurvive: string;
  why: string;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function loadRedactionPositives(): RedactionPositiveCase[] {
  return readJsonl<RedactionPositiveCase>(join(REDACTION_DIR, 'positive.jsonl'));
}

export function loadRedactionNegatives(): RedactionNegativeCase[] {
  return readJsonl<RedactionNegativeCase>(join(REDACTION_DIR, 'negative.jsonl'));
}

/** Read the emitted JSON rather than the TypeScript, so tests exercise what Rust will read. */
export function listGoldenSessionIds(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadGoldenSession(id: string): GoldenSession {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${id}.json`), 'utf8')) as GoldenSession;
}

export function loadAllGoldenSessions(): GoldenSession[] {
  return listGoldenSessionIds().map(loadGoldenSession);
}

/**
 * Shift a session's absolute timestamps so tests never depend on a wall clock, while preserving
 * every relative gap — the gaps are what the context engine actually reasons about.
 */
export function shiftToNow(session: GoldenSession, now = Date.now()): GoldenSession {
  const last = Math.max(...session.events.map((e) => e.endTimestamp ?? e.timestamp));
  const delta = now - last;
  const shift = (t: number) => t + delta;
  return {
    ...session,
    events: session.events.map((e) => ({
      ...e,
      timestamp: shift(e.timestamp),
      ...(e.endTimestamp !== undefined ? { endTimestamp: shift(e.endTimestamp) } : {}),
    })),
    expected: {
      ...session.expected,
      contexts: session.expected.contexts.map((c) => ({
        ...c,
        startTimestamp: shift(c.startTimestamp),
        endTimestamp: shift(c.endTimestamp),
      })),
    },
  };
}
