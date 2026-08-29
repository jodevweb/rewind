/**
 * The searchable corpus: what a question is actually matched against.
 *
 * Not raw events. A day of capture is thousands of events and dozens of them say the same thing —
 * one documentation page read twenty times is twenty events and one memory. So events are folded
 * into **rows**, keyed by what they point at within a context, and a row carries the count and the
 * span instead of repeating itself down the list (SEARCH §6, "deduplication").
 *
 * This is also where the privacy line sits. A row is built only from fields the interface already
 * shows — paths, URLs, redacted commands, redacted commit messages, titles. Search must never become
 * the way something reaches the screen that the capture rules kept off it, so the allowlist below is
 * explicit and there is no object walk anywhere in this file.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { runEngine, type EngineContext, type EngineResult } from '@rewind/engine-v0';

import { tokenize } from './text.js';
import { lunchHour } from './time.js';

export type RowKind = 'url' | 'file' | 'command' | 'commit' | 'agent' | 'note' | 'error' | 'window';

export interface Row {
  /** Dedupe identity: one row per thing, per context. */
  key: string;
  kind: RowKind;
  /** What it is, in the reader's own data — a path, a URL, a command. Never generated prose. */
  label: string;
  detail?: string;
  /** Openable, when there is something to open. */
  target?: string;
  contextId: string | null;
  contextLabel: string | null;
  occurrences: number;
  firstAt: number;
  lastAt: number;
  tzOffsetMinutes: number;
  /** Highest importance among the events folded in — a failing command outranks a glance. */
  importance: number;
  privacyLevel: GoldenEvent['privacyLevel'];
  /** Event refs, newest first. These are the citations. */
  evidence: string[];
  /** Folded, identifier-split tokens. Built once; the ranker only reads them. */
  tokens: string[];
}

export interface Corpus {
  rows: Row[];
  contexts: EngineContext[];
  /**
   * The offset the events were captured at.
   *
   * Every window resolves against this and never against the offset the question is asked at
   * (TR-8) — a flight between the work and the question must not move the memory.
   */
  tzOffsetMinutes: number;
  /** The reader's own lunch hour, counted from their longest midday gap. */
  lunchHour: number;
  /** Query-time affinity is computed against these: label, place and anchor values, tokenised. */
  contextTokens: Map<string, string[]>;
  engine: EngineResult;
  byRef: Map<string, GoldenEvent>;
}

const str = (e: GoldenEvent, key: string): string | undefined => {
  const value = e.metadata[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const leaf = (path: string): string => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/**
 * The facets one event contributes.
 *
 * An event can be more than one thing: a commit is a message *and* a branch, a file save is a path
 * *and* a window. Emitting several rows from one event is what lets "the auth file" and "the commit
 * about auth" both be findable without either query having to guess which the other meant.
 */
function facets(
  e: GoldenEvent,
): { kind: RowKind; label: string; detail?: string; target?: string }[] {
  const out: { kind: RowKind; label: string; detail?: string; target?: string }[] = [];

  const url = str(e, 'url');
  if (url) out.push({ kind: 'url', label: e.title ?? url, detail: url, target: url });

  const path = str(e, 'path') ?? str(e, 'toPath');
  if (path) out.push({ kind: 'file', label: leaf(path), detail: path, target: path });

  const workspace = str(e, 'workspacePath') ?? str(e, 'projectPath') ?? str(e, 'worktree');
  if (workspace) {
    out.push({ kind: 'file', label: leaf(workspace), detail: workspace, target: workspace });
  }

  const command = str(e, 'commandRedacted');
  if (command) {
    const exit = e.metadata['exitCode'];
    out.push({
      kind: e.type === 'terminal.error_tail' || exit !== 0 ? 'error' : 'command',
      label: command,
      detail: str(e, 'cwd') ?? str(e, 'directory'),
    });
  }

  if (e.type === 'git.commit') {
    const message = str(e, 'messageRedacted');
    if (message) {
      out.push({ kind: 'commit', label: message, detail: str(e, 'branch') ?? str(e, 'sha') });
    }
  }

  if (e.type.startsWith('git.branch') && str(e, 'to')) {
    out.push({ kind: 'commit', label: str(e, 'to')!, detail: str(e, 'repository') });
  }

  if (e.type === 'manual.note' && str(e, 'text')) {
    out.push({ kind: 'note', label: str(e, 'text')! });
  }

  if (e.type.startsWith('agent.')) {
    const title = str(e, 'title') ?? e.title;
    if (title) out.push({ kind: 'agent', label: title, detail: str(e, 'projectPath') });
  }

  if (e.type === 'ide.diagnostic.error' && str(e, 'messageRedacted')) {
    out.push({ kind: 'error', label: str(e, 'messageRedacted')!, detail: path });
  }

  // A terminal's error output arrives as lines. Only the first is indexed: it is the one a reader
  // recognises and the one they would type back, and the tail below it is stack frames.
  if (e.type === 'terminal.error_tail') {
    const lines = e.metadata['lines'];
    const first = Array.isArray(lines) ? lines[0] : undefined;
    if (typeof first === 'string' && first.trim() !== '') {
      out.push({ kind: 'error', label: first, detail: str(e, 'cwd') });
    }
  }

  // Everything that reached the machine reached it inside a window, and the title is most of the
  // Level 1 signal. Emitted last so a more specific facet from the same event ranks ahead of it.
  if (e.title) {
    out.push({ kind: 'window', label: e.title, detail: e.appDisplay ?? e.app });
  }

  return out;
}

/** Rows are the same memory when they point at the same thing inside the same context. */
const identity = (contextId: string | null, kind: RowKind, label: string, target?: string) =>
  `${contextId ?? '-'}|${kind}|${(target ?? label).toLowerCase()}`;

/**
 * Build the corpus for a session.
 *
 * The engine runs here rather than being passed in because a row's context is part of its identity:
 * the same file touched in two pieces of work is two memories, and collapsing them would answer
 * "when did I work on this" with one blurred span covering both.
 */
export function buildCorpus(session: GoldenSession): Corpus {
  const engine = runEngine(session);
  const byRef = new Map(session.events.map((e) => [e.ref, e]));

  const contextOf = new Map<string, EngineContext>();
  for (const context of engine.contexts) {
    for (const ref of context.eventRefs) contextOf.set(ref, context);
  }

  const rows = new Map<string, Row>();
  for (const event of session.events) {
    const context = contextOf.get(event.ref) ?? null;
    for (const facet of facets(event)) {
      const key = identity(context?.id ?? null, facet.kind, facet.label, facet.target);
      const existing = rows.get(key);
      if (existing) {
        existing.occurrences += 1;
        existing.firstAt = Math.min(existing.firstAt, event.timestamp);
        existing.lastAt = Math.max(existing.lastAt, event.endTimestamp ?? event.timestamp);
        existing.importance = Math.max(existing.importance, event.importance);
        // Newest first: the citation a reader wants is the last time it happened, and the list is
        // capped so a page visited two hundred times does not carry two hundred refs around.
        if (existing.evidence.length < 24) existing.evidence.unshift(event.ref);
        continue;
      }
      rows.set(key, {
        key,
        kind: facet.kind,
        label: facet.label,
        ...(facet.detail ? { detail: facet.detail } : {}),
        ...(facet.target ? { target: facet.target } : {}),
        contextId: context?.id ?? null,
        contextLabel: context?.label ?? null,
        occurrences: 1,
        firstAt: event.timestamp,
        lastAt: event.endTimestamp ?? event.timestamp,
        tzOffsetMinutes: event.tzOffsetMinutes ?? session.tzOffsetMinutes,
        importance: event.importance,
        privacyLevel: event.privacyLevel,
        evidence: [event.ref],
        tokens: [
          ...tokenize(facet.label),
          ...(facet.detail ? tokenize(facet.detail) : []),
          ...tokenize(event.appDisplay ?? event.app ?? ''),
        ],
      });
    }
  }

  const contextTokens = new Map<string, string[]>();
  for (const context of engine.contexts) {
    contextTokens.set(context.id, [
      ...tokenize(context.label),
      ...tokenize(context.place.repository ?? ''),
      ...tokenize(context.place.branch ?? ''),
      ...tokenize(context.place.project ?? ''),
      ...context.anchors.flatMap((a) => tokenize(a.value)),
    ]);
  }

  return {
    rows: [...rows.values()],
    contexts: engine.contexts,
    tzOffsetMinutes: session.tzOffsetMinutes,
    lunchHour: lunchHour(session),
    contextTokens,
    engine,
    byRef,
  };
}
