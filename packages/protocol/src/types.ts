/**
 * Core domain types (EVENT_MODEL.md).
 *
 * INTERIM: these are hand-authored so Phase 0 work can proceed. Ticket P0-003 replaces this file
 * with output generated from `schemas/*.json`, which is already the authoritative definition — if
 * this file and the schema disagree, the schema is right. Once codegen lands, editing these types
 * by hand becomes a review-blocking error.
 */

export type EventSource =
  'system' | 'browser' | 'ide' | 'filesystem' | 'git' | 'terminal' | 'agent' | 'manual';

/**
 * A distinctive identifier that recurs across applications (ADR 0002 D-14).
 *
 * Anchors are the primary grouping signal. They are what lets a Slack window, a Linear window, a
 * Figma document, a Git branch and a Cockpit mission be recognised as one piece of work — including
 * for contexts that touch no code at all.
 */
export interface ContextAnchor {
  type: 'issue' | 'project' | 'repository' | 'branch' | 'worktree' | 'document' | 'url' | 'keyword';
  value: string;
  /** What comparison uses. Lower-cased, accent-folded, punctuation-normalised. */
  normalizedValue: string;
  confidence: number;
  source: 'window_title' | 'url' | 'branch' | 'agent' | 'external' | 'note' | 'path';
}

export type PrivacyLevel = 'normal' | 'sensitive' | 'private';

export interface ProducerIdentity {
  name: string;
  version: string;
}

export interface EventRedactionStamp {
  patternsVersion: string;
  /** Detector ids that fired. Never the matched values. */
  applied: string[];
  count: number;
}

/**
 * The canonical event. Produced by a collector, redacted and enriched by the normaliser,
 * and rejected by persistence if `redaction` is absent (PRIVACY.md §4.2).
 */
export interface TimelineEvent {
  /** UUIDv7 — time-ordered, producer-generated, used for idempotent ingest. */
  id: string;
  /** Epoch milliseconds, UTC. */
  timestamp: number;
  /** Epoch milliseconds, UTC. Present for events with duration. */
  endTimestamp?: number;
  /** Local UTC offset in minutes at capture time. Required for temporal queries (TR-8). */
  tzOffsetMinutes: number;

  source: EventSource;
  /** Namespaced, e.g. "system.window.focus", "git.commit", "terminal.command". */
  type: string;
  producer: ProducerIdentity;

  app?: string;
  appDisplay?: string;
  /** Redacted. Marked sensitive by default for apps outside the safe allowlist (PRIVACY.md §3.3). */
  title?: string;

  projectId?: string;
  repositoryId?: string;

  /** Type-specific payload, validated per event type at ingest. */
  metadata: Record<string, unknown>;

  privacyLevel: PrivacyLevel;
  redaction: EventRedactionStamp;

  /** Assembled by the normaliser only — never by a producer. */
  searchableText?: string;

  /** 0..100, from the table in EVENT_MODEL.md §2.2. */
  importance: number;

  /**
   * Extracted by the normaliser, never supplied by a producer — except Level 2 sources, which know
   * their own domain and may declare anchors explicitly at high confidence.
   */
  anchors: ContextAnchor[];

  /** Assigned by the context engine, revisable, never set by a collector. */
  activityId?: string;
  contextId?: string;
}

export type PrivacyRuleType = 'application' | 'domain' | 'path' | 'title' | 'eventType';
export type PrivacyAction = 'ignore' | 'redact';

export interface PrivacyRule {
  id: string;
  type: PrivacyRuleType;
  /** Glob for path/application, suffix match for domain, regex for title. */
  matcher: string;
  action: PrivacyAction;
  enabled: boolean;
  source: 'default' | 'user';
}

export interface PauseInterval {
  id: string;
  startedAt: number;
  endsAt?: number;
  reason: 'manual' | 'scheduled' | 'excluded_app_focus';
}

/** Fields that must pass through the redactor before an event may be persisted. */
export const REDACTABLE_EVENT_FIELDS = ['title', 'searchableText'] as const;
