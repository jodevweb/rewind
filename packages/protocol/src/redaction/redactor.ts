/**
 * Secret redactor — TypeScript implementation.
 *
 * This is the extension-side half of the two-implementation design in ARCHITECTURE.md §3.
 * The Rust implementation in `rewind-privacy` is the authoritative one (it runs on the hot path
 * between collection and persistence); this one runs inside the browser and IDE extensions so that
 * secrets are removed before they ever leave the producing process.
 *
 * Both are driven by the SAME `redaction/patterns.json` and validated against the SAME fixture
 * corpus by a conformance test. If they ever disagree on a single fixture, that is a build failure.
 *
 * Contract (PRIVACY.md §4.2 — fail closed):
 *   - `redactText` is total. It never throws. On an internal error it returns a failure marker and
 *     the caller MUST drop the event rather than persist it.
 *   - Losing an event is acceptable. Storing a secret is not.
 */

import registryJson from '../../redaction/patterns.json';

const registry = registryJson as unknown as PatternRegistry;

export type Confidence = 'certain' | 'high' | 'medium';

export interface PatternDefinition {
  id: string;
  description: string;
  regex: string;
  flags: string;
  confidence: Confidence;
  replacement: string;
}

export interface PatternRegistry {
  version: string;
  note: string;
  patterns: PatternDefinition[];
  entropy: {
    enabledByDefault: boolean;
    note: string;
    minLength: number;
    maxLength: number;
    minEntropyBitsPerChar: number;
    allowShapes: { id: string; regex: string }[];
  };
}

export interface RedactionStamp {
  /** Version of the pattern registry that produced this result. */
  patternsVersion: string;
  /** Detector ids that fired. Never the matched values. */
  applied: string[];
  count: number;
}

export interface RedactionSuccess {
  ok: true;
  text: string;
  stamp: RedactionStamp;
}

export interface RedactionFailure {
  ok: false;
  /** Detector id or stage that failed. Safe to log — contains no user data. */
  reason: string;
}

export type RedactionResult = RedactionSuccess | RedactionFailure;

export interface RedactorOptions {
  /**
   * Enable the generic high-entropy stage. Off by default: it destroys evidence we need
   * (git SHAs are high-entropy AND are primary evidence — INITIAL_ANALYSIS TR-10).
   */
  enableEntropy?: boolean;
  entropyThreshold?: number;
  /** Extra user-supplied patterns from Settings (PRIVACY.md §4.5). */
  extraPatterns?: PatternDefinition[];
}

export const PATTERNS_VERSION: string = registry.version;

interface CompiledPattern {
  id: string;
  regex: RegExp;
  replacement: string;
}

function compile(defs: PatternDefinition[]): CompiledPattern[] {
  return defs.map((d) => ({
    id: d.id,
    // 'g' is always added; the source patterns must never carry it themselves.
    regex: new RegExp(d.regex, d.flags.includes('g') ? d.flags : d.flags + 'g'),
    replacement: d.replacement,
  }));
}

export class SecretRedactor {
  private readonly patterns: CompiledPattern[];
  private readonly entropyEnabled: boolean;
  private readonly entropyThreshold: number;
  private readonly allowShapes: RegExp[];
  private readonly entropyMin: number;
  private readonly entropyMax: number;

  constructor(options: RedactorOptions = {}) {
    const defs = [...registry.patterns, ...(options.extraPatterns ?? [])];
    this.patterns = compile(defs);
    this.entropyEnabled = options.enableEntropy ?? registry.entropy.enabledByDefault;
    this.entropyThreshold = options.entropyThreshold ?? registry.entropy.minEntropyBitsPerChar;
    this.entropyMin = registry.entropy.minLength;
    this.entropyMax = registry.entropy.maxLength;
    this.allowShapes = registry.entropy.allowShapes.map((s) => new RegExp(s.regex));
  }

  /**
   * Redact a single string. Total: never throws.
   */
  redactText(input: string | undefined | null): RedactionResult {
    if (input === undefined || input === null || input === '') {
      return { ok: true, text: input ?? '', stamp: emptyStamp() };
    }

    let text = input;
    const applied: string[] = [];
    let count = 0;

    for (const p of this.patterns) {
      try {
        p.regex.lastIndex = 0;
        let hits = 0;
        const next = text.replace(p.regex, (...args) => {
          hits += 1;
          // Support $1 group references in the replacement without regex lookarounds.
          return p.replacement.replace(/\$(\d)/g, (_m, g: string) => args[Number(g)] ?? '');
        });
        if (hits > 0) {
          applied.push(p.id);
          count += hits;
          text = next;
        }
      } catch (err) {
        // Fail closed: a detector that misbehaves must not result in unredacted output.
        return { ok: false, reason: `pattern:${p.id}` };
      }
    }

    if (this.entropyEnabled) {
      try {
        const result = this.redactHighEntropyTokens(text);
        if (result.hits > 0) {
          applied.push('high_entropy');
          count += result.hits;
          text = result.text;
        }
      } catch {
        return { ok: false, reason: 'stage:entropy' };
      }
    }

    return {
      ok: true,
      text,
      stamp: { patternsVersion: PATTERNS_VERSION, applied, count },
    };
  }

  /**
   * Redact every string field of a record. Fails closed as a whole: if any field fails,
   * the caller gets a failure and must drop the entire event, not just the field.
   */
  redactFields<T extends Record<string, unknown>>(
    record: T,
    fields: (keyof T & string)[],
  ): { ok: true; record: T; stamp: RedactionStamp } | RedactionFailure {
    const out: Record<string, unknown> = { ...record };
    const applied = new Set<string>();
    let count = 0;

    for (const field of fields) {
      const value = record[field];
      if (typeof value !== 'string') continue;
      const result = this.redactText(value);
      if (!result.ok) return result;
      out[field] = result.text;
      result.stamp.applied.forEach((a) => applied.add(a));
      count += result.stamp.count;
    }

    return {
      ok: true,
      record: out as T,
      stamp: { patternsVersion: PATTERNS_VERSION, applied: [...applied], count },
    };
  }

  private redactHighEntropyTokens(text: string): { text: string; hits: number } {
    let hits = 0;
    const out = text.replace(/\S+/g, (token) => {
      if (token.length < this.entropyMin || token.length > this.entropyMax) return token;
      // Paths and URLs are structure, not secrets.
      if (token.includes('/') || token.includes('\\')) return token;
      if (this.allowShapes.some((shape) => shape.test(token))) return token;
      if (shannonEntropy(token) < this.entropyThreshold) return token;
      hits += 1;
      return '[REDACTED:high_entropy]';
    });
    return { text: out, hits };
  }
}

function emptyStamp(): RedactionStamp {
  return { patternsVersion: PATTERNS_VERSION, applied: [], count: 0 };
}

/** Shannon entropy in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Shared default instance. */
export const defaultRedactor = new SecretRedactor();
