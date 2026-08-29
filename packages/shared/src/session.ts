/**
 * The seam between the daemon's rows and the event model everything else speaks.
 *
 * The daemon stores a narrow struct with an opaque JSON payload; the engine, the prediction layer
 * and Ask all consume `GoldenSession`. Converting between the two is four lines of obvious code and
 * three that are not obvious at all — the timezone the events were captured at, the payload parsed
 * once rather than per field, and the repository lifted out of the payload into the top-level field
 * anchors are read from.
 *
 * It lived in the desktop window until a second reader appeared. Two copies of this would not
 * disagree loudly: they would disagree about the repository anchor, and a context would quietly
 * group differently depending on which program asked.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

/** One row as the daemon serves it, over Tauri's IPC or read back out of SQLite. */
export interface DaemonEvent {
  timestamp: number;
  endTimestamp: number | null;
  tzOffsetMinutes: number;
  source: string;
  type: string;
  appId: string;
  appDisplay: string;
  title: string;
  pid: number | null;
  /** JSON. Opaque to the daemon, meaningful to the engine — anchors live in here. */
  metadata: string;
  redactionVersion: string;
  redactionApplied: string[];
  redactionCount: number;
  importance: number;
}

/** A malformed payload must never take the timeline with it. */
export function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function toSession(events: DaemonEvent[], id = 'live', day?: string): GoldenSession {
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  // The offset the events were captured at, not the one this machine is in now. A day looked at
  // from another timezone must read as the day it was, at the hours it happened (TR-8).
  const tz = ordered[0]?.tzOffsetMinutes ?? -new Date().getTimezoneOffset();

  return {
    id,
    name: 'Aujourd’hui',
    description: 'Activité capturée sur cette machine.',
    tests: '',
    day: day ?? new Date().toISOString().slice(0, 10),
    tzOffsetMinutes: tz,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events: ordered.map((e, i): GoldenEvent => {
      // Parsed once: this runs over every event of every day on screen.
      const payload = parseMetadata(e.metadata);
      const repository = payload['repository'];
      return {
        id: `${id}-${i}`,
        ref: `${id}-${String(i).padStart(5, '0')}`,
        timestamp: e.timestamp,
        ...(e.endTimestamp !== null ? { endTimestamp: e.endTimestamp } : {}),
        tzOffsetMinutes: e.tzOffsetMinutes,
        source: e.source as GoldenEvent['source'],
        type: e.type,
        producer: { name: 'rewind-daemon', version: '0.1.0' },
        app: e.appId,
        appDisplay: e.appDisplay,
        title: e.title,
        metadata: {
          bundleId: e.appId,
          ...(e.pid !== null ? { pid: e.pid } : {}),
          ...payload,
        },
        // A repository anchor is read from this top-level field, never from metadata, so a git
        // event that names its repository has to have it lifted here or the anchor never fires.
        ...(typeof repository === 'string' ? { repositoryId: repository } : {}),
        privacyLevel: 'normal' as const,
        redaction: {
          patternsVersion: e.redactionVersion,
          applied: e.redactionApplied,
          count: e.redactionCount,
        },
        importance: e.importance,
      };
    }),
  };
}
