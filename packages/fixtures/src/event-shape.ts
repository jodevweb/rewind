/**
 * Minimal structural types for fixtures.
 *
 * Deliberately NOT importing from @rewind/protocol: fixtures must stay loadable by tooling that
 * has no dependency on the protocol package, and a fixture is test data rather than a production
 * event. The one field that differs is `id` — fixtures also carry a readable `ref`, which is what
 * ground truth references, because "gs01-e007" is reviewable in a diff and a UUID is not.
 */

export type EventSource =
  | 'system'
  | 'browser'
  | 'ide'
  | 'filesystem'
  | 'git'
  | 'terminal'
  | 'agent'
  // Authorised local applications emitting the ExternalContextEvent protocol (ADR 0002 D-17).
  | 'external'
  | 'manual';
