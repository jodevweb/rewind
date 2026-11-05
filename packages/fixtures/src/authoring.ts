/**
 * Golden session authoring (ticket P0-005).
 *
 * A golden session is ~40–80 events with a hand-declared ground truth. Written as raw JSON that is
 * unmaintainable: nobody can edit 80 objects by hand, and the ground truth drifts away from the
 * events the moment someone inserts one in the middle.
 *
 * So the readable, editable, reviewable form is TypeScript — one event per line, with its
 * ground-truth context tag written *on the event itself*. The expected contexts are then derived,
 * which makes desynchronisation between events and ground truth structurally impossible.
 *
 * `pnpm --filter @rewind/fixtures build:golden` emits `golden/*.json`, the language-neutral artefact
 * the Rust engine reads. Both forms are committed; CI fails if the JSON is stale.
 */

import type { EventSource } from './event-shape.js';

/** Ground-truth context tag. `null` means the event belongs to no context — noise. */
export type CtxTag = string | null;

export interface Step {
  /** "HH:MM:SS", or "D HH:MM:SS" for a session that crosses days. */
  t: string;
  /** The context this event truly belongs to. `null` for noise. */
  ctx: CtxTag;
  type: string;
  app?: string;
  title?: string;
  /** End time for events with duration ("HH:MM:SS"). */
  endT?: string;
  /** Repository this event belongs to; defaults to the session's default repo. */
  repo?: string | null;
  /** Marks an event a Resume card must surface. Measured by `importantEventRecall`. */
  important?: boolean;
  meta?: Record<string, unknown>;
  /** Free-text explanation for a human reader. Carried into the JSON. */
  note?: string;
  /** Override the derived importance score. */
  importance?: number;
  privacyLevel?: 'normal' | 'sensitive' | 'private';
}

export type ExpectedOutcome =
  'fix_implemented' | 'pr_opened' | 'pr_merged' | 'abandoned' | 'blocked' | 'unresolved';

export interface ContextSpec {
  /** Human topic. The engine's generated name is scored loosely against `labelMatches`. */
  label: string;
  /** Regex the inferred context name should match. */
  labelMatches?: string;
  outcome?: ExpectedOutcome;
  /** What a correct Resume card should propose next. Scored by hand, not automatically. */
  expectedNextStep?: string;
  note?: string;
}

export interface SessionSpec {
  id: string;
  name: string;
  description: string;
  /** ISO date of the session's first day. */
  day: string;
  tzOffsetMinutes: number;
  defaultRepo?: string | null;
  /** Ground-truth contexts, keyed by the tag used on steps. */
  contexts: Record<string, ContextSpec>;
  /** What this fixture exists to prove. Kept in the JSON so a failure explains itself. */
  tests: string;
  steps: Step[];
}

export interface GoldenEvent {
  /** Deterministic UUID, so fixtures can be replayed through the real pipeline unchanged. */
  id: string;
  /** Readable handle. Ground truth references these, not UUIDs. */
  ref: string;
  timestamp: number;
  endTimestamp?: number;
  tzOffsetMinutes: number;
  source: EventSource;
  type: string;
  producer: { name: string; version: string };
  app?: string;
  appDisplay?: string;
  title?: string;
  repositoryId?: string;
  metadata: Record<string, unknown>;
  privacyLevel: 'normal' | 'sensitive' | 'private';
  redaction: { patternsVersion: string; applied: string[]; count: number };
  importance: number;
  $note?: string;
}

export interface ExpectedContext {
  tag: string;
  label: string;
  labelMatches?: string;
  outcome?: ExpectedOutcome;
  expectedNextStep?: string;
  startTimestamp: number;
  endTimestamp: number;
  /** Every event that truly belongs to this context. */
  eventRefs: string[];
  /** The subset a Resume card must surface. */
  importantEventRefs: string[];
  note?: string;
}

export interface GoldenSession {
  $schema?: string;
  id: string;
  name: string;
  description: string;
  tests: string;
  day: string;
  tzOffsetMinutes: number;
  expected: {
    contextCount: number;
    contexts: ExpectedContext[];
    /** Events belonging to no context. An engine may drop or isolate these; both are acceptable. */
    noiseEventRefs: string[];
  };
  events: GoldenEvent[];
}

const SOURCE_BY_PREFIX: Record<string, EventSource> = {
  system: 'system',
  browser: 'browser',
  ide: 'ide',
  fs: 'filesystem',
  git: 'git',
  terminal: 'terminal',
  agent: 'agent',
  external: 'external',
  manual: 'manual',
};

/**
 * Importance, from the table in EVENT_MODEL.md §2.2. Derived rather than written per event so the
 * fixtures stay terse and stay consistent with the production scorer.
 */
function deriveImportance(step: Step, durationMs: number | undefined): number {
  const { type, meta } = step;
  const exitCode = meta?.['exitCode'];

  if (type === 'terminal.command') return exitCode !== 0 ? 95 : 65;
  if (type === 'git.commit') return 90;
  if (type === 'manual.note' || type === 'manual.bookmark') return 90;
  if (type === 'terminal.error_tail' || type === 'ide.diagnostic.error') return 85;
  if (type.startsWith('git.branch') || type === 'git.merge' || type === 'git.rebase') return 80;
  if (type === 'ide.file.saved') return 70;
  if (type.startsWith('agent.')) return 70;
  if (type.startsWith('external.')) return 75;
  if (type === 'browser.navigation' || type === 'browser.tab.activated') {
    if (durationMs !== undefined && durationMs < 5000) return 5;
    if (durationMs !== undefined && durationMs < 30000) return 35;
    return 60;
  }
  if (type === 'ide.file.opened' || type === 'ide.workspace.opened') return 45;
  if (type === 'git.repo.detected' || type === 'git.status.summary') return 45;
  if (type.startsWith('fs.')) return 40;
  if (type === 'system.window.focus') {
    if (durationMs === undefined) return 30;
    if (durationMs < 5000) return 5;
    if (durationMs < 60000) return 15;
    return 30;
  }
  if (type.startsWith('system.idle') || type.startsWith('system.session')) return 50;
  return 30;
}

function parseTime(day: string, t: string, tzOffsetMinutes: number): number {
  const match = /^(?:(\d+)\s+)?(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!match) throw new Error(`Bad time "${t}" — expected "HH:MM:SS" or "D HH:MM:SS"`);
  const dayOffset = Number(match[1] ?? 0);
  const [h, m, s] = [Number(match[2]), Number(match[3]), Number(match[4])];
  const base = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(base)) throw new Error(`Bad day "${day}"`);
  return (
    base + dayOffset * 86_400_000 + h * 3_600_000 + m * 60_000 + s * 1000 - tzOffsetMinutes * 60_000
  );
}

/** Deterministic UUIDv7-shaped id, so replays are byte-stable across runs and machines. */
function deterministicId(sessionId: string, index: number): string {
  let hash = 0x811c9dc5;
  for (const ch of sessionId) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const a = hash.toString(16).padStart(8, '0').slice(0, 8);
  const b = (hash & 0xffff).toString(16).padStart(4, '0');
  const tail = index.toString(16).padStart(12, '0');
  return `${a}-${b}-7000-8000-${tail}`;
}

const KNOWN_APPS: Record<string, string> = {
  // macOS bundle identifiers — the MVP platform (ADR 0002). `app` carries the bundle id, which is
  // the stable identity; the display name is derived, never captured as a separate signal.
  'com.tinyspeck.slackmacgap': 'Slack',
  'com.linear': 'Linear',
  'com.figma.Desktop': 'Figma',
  'com.apple.Notes': 'Notes',
  'com.apple.mail': 'Mail',
  'com.apple.finder': 'Finder',
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm2',
  'com.google.Chrome': 'Google Chrome',
  'com.apple.Safari': 'Safari',
  'com.acme.cockpit': 'Cockpit',
  'com.apple.Preview': 'Preview',
  'com.microsoft.VSCode': 'Visual Studio Code',
  'Code.exe': 'Visual Studio Code',
  'chrome.exe': 'Google Chrome',
  'WindowsTerminal.exe': 'Windows Terminal',
  'slack.exe': 'Slack',
  'Teams.exe': 'Microsoft Teams',
  'olk.exe': 'Outlook',
  'Spotify.exe': 'Spotify',
  'explorer.exe': 'File Explorer',
};

export function buildSession(spec: SessionSpec): GoldenSession {
  const events: GoldenEvent[] = [];
  const byTag = new Map<
    string,
    { refs: string[]; important: string[]; from: number; to: number }
  >();
  const noise: string[] = [];
  let lastTimestamp = -Infinity;

  spec.steps.forEach((step, i) => {
    const prefix = step.type.split('.')[0] ?? '';
    const source = SOURCE_BY_PREFIX[prefix];
    if (!source) throw new Error(`${spec.id}: unknown event source for type "${step.type}"`);
    if (step.ctx !== null && !spec.contexts[step.ctx]) {
      throw new Error(`${spec.id}: step ${i} references undeclared context "${step.ctx}"`);
    }

    const timestamp = parseTime(spec.day, step.t, spec.tzOffsetMinutes);
    if (timestamp < lastTimestamp) {
      throw new Error(`${spec.id}: step ${i} (${step.t}) goes backwards in time`);
    }
    lastTimestamp = timestamp;

    const endTimestamp =
      step.endT === undefined ? undefined : parseTime(spec.day, step.endT, spec.tzOffsetMinutes);
    const durationMs = endTimestamp === undefined ? undefined : endTimestamp - timestamp;
    const ref = `${spec.id}-e${String(i + 1).padStart(3, '0')}`;
    const repo = step.repo === undefined ? spec.defaultRepo : step.repo;

    const event: GoldenEvent = {
      id: deterministicId(spec.id, i + 1),
      ref,
      timestamp,
      ...(endTimestamp !== undefined ? { endTimestamp } : {}),
      tzOffsetMinutes: spec.tzOffsetMinutes,
      source,
      type: step.type,
      producer: { name: `rewind-${source}`, version: '0.1.0' },
      ...(step.app ? { app: step.app, appDisplay: KNOWN_APPS[step.app] ?? step.app } : {}),
      ...(step.title ? { title: step.title } : {}),
      ...(repo ? { repositoryId: repo } : {}),
      metadata: step.meta ?? {},
      privacyLevel: step.privacyLevel ?? 'normal',
      redaction: { patternsVersion: '1.0.1', applied: [], count: 0 },
      importance: step.importance ?? deriveImportance(step, durationMs),
      ...(step.note ? { $note: step.note } : {}),
    };
    events.push(event);

    if (step.ctx === null) {
      noise.push(ref);
      return;
    }
    const bucket = byTag.get(step.ctx) ?? {
      refs: [],
      important: [],
      from: timestamp,
      to: endTimestamp ?? timestamp,
    };
    bucket.refs.push(ref);
    if (step.important) bucket.important.push(ref);
    bucket.from = Math.min(bucket.from, timestamp);
    bucket.to = Math.max(bucket.to, endTimestamp ?? timestamp);
    byTag.set(step.ctx, bucket);
  });

  for (const tag of Object.keys(spec.contexts)) {
    if (!byTag.has(tag)) throw new Error(`${spec.id}: context "${tag}" has no events`);
  }

  const contexts: ExpectedContext[] = Object.entries(spec.contexts).map(([tag, ctx]) => {
    const bucket = byTag.get(tag)!;
    return {
      tag,
      label: ctx.label,
      ...(ctx.labelMatches ? { labelMatches: ctx.labelMatches } : {}),
      ...(ctx.outcome ? { outcome: ctx.outcome } : {}),
      ...(ctx.expectedNextStep ? { expectedNextStep: ctx.expectedNextStep } : {}),
      startTimestamp: bucket.from,
      endTimestamp: bucket.to,
      eventRefs: bucket.refs,
      importantEventRefs: bucket.important,
      ...(ctx.note ? { note: ctx.note } : {}),
    };
  });

  return {
    $schema: '../schemas/golden-session.json',
    id: spec.id,
    name: spec.name,
    description: spec.description,
    tests: spec.tests,
    day: spec.day,
    tzOffsetMinutes: spec.tzOffsetMinutes,
    expected: { contextCount: contexts.length, contexts, noiseEventRefs: noise },
    events,
  };
}
