import { buildSession, type Step } from '../authoring.js';

/**
 * The failure this fixture exists to catch was found on a real machine, not here: an afternoon of
 * work followed by an evening of gaming, and the whole evening landed inside the work context.
 *
 * The cause was a ratchet. Drift — how long an activity carrying no anchors may still attach to
 * nearby work — was measured from the context's end, which anchorless attachment itself advances.
 * So each unlabelled activity attached, pushed the end forward, and thereby made the next one
 * "nearby" as well. Nothing bounded how much unrelated material a context could accrete.
 *
 * Drift is now measured from the last activity that actually carried identity. That is the property
 * under test here, and no other fixture exercises it: the others are all working sessions, where
 * real evidence never stops arriving for long enough for the ratchet to matter.
 *
 * Every evening step sets `repo: null`. `defaultRepo` stamps a repository anchor onto every step,
 * gaming included, and the first draft of this fixture asserted nothing because of it: the evening
 * shared an anchor with the afternoon and merged for that reason rather than through drift. Dropping
 * the default altogether was worse — the afternoon then had nothing tying it together and fragmented.
 *
 * The gaming half deliberately carries no anchors at all — no path, no repository, no URL. That is
 * what Level 1 capture looks like for an application that is not work, and it is precisely the case
 * that must not be absorbed.
 */
const s: Step[] = [
  // ── Afternoon: real work, with real evidence. ───────────────────────────────
  {
    t: '16:00:00',
    ctx: 'importer',
    type: 'system.window.focus',
    app: 'Code',
    title: 'importer.ts — mimiq',
    endT: '16:12:00',
  },
  {
    t: '16:00:10',
    ctx: 'importer',
    type: 'ide.workspace.opened',
    meta: { workspacePath: '/Users/j/dev/mimiq', ideName: 'vscode', ideVersion: '1.96.0' },
  },
  {
    t: '16:01:30',
    ctx: 'importer',
    type: 'git.branch.checkout',
    important: true,
    meta: { from: 'main', to: 'feat/csv-importer', repository: 'mimiq' },
  },
  {
    t: '16:04:00',
    ctx: 'importer',
    type: 'ide.file.saved',
    meta: { path: '/Users/j/dev/mimiq/src/importer.ts', language: 'typescript', lineCount: 210 },
  },
  {
    t: '16:09:00',
    ctx: 'importer',
    type: 'terminal.command',
    important: true,
    meta: {
      commandRedacted: 'pnpm test importer',
      exitCode: 0,
      durationMs: 8400,
      cwd: '/Users/j/dev/mimiq',
    },
  },
  {
    t: '16:12:00',
    ctx: 'importer',
    type: 'git.commit',
    important: true,
    meta: {
      messageRedacted: 'feat: csv importer handles quoted separators',
      repository: 'mimiq',
      branch: 'feat/csv-importer',
      filesChanged: 3,
      insertions: 88,
      deletions: 12,
    },
  },

  // ── Evening: three hours of a game. No anchors of any kind. ─────────────────
  //
  // The first minutes are legitimately ambiguous — a short unlabelled stretch right after work
  // usually IS the tail of that work, which is why drift exists at all. What must not happen is
  // the whole evening following it in.
  {
    t: '16:20:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'League of Legends',
    title: 'League of Legends',
    endT: '16:48:00',
  },
  {
    t: '16:48:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'League of Legends',
    title: 'League of Legends (TM) Client',
    endT: '17:20:00',
  },
  {
    t: '17:20:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'League of Legends',
    title: 'League of Legends',
    endT: '17:55:00',
  },
  {
    t: '17:55:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'Discord',
    title: 'Discord',
    endT: '18:05:00',
  },
  {
    t: '18:05:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'League of Legends',
    title: 'League of Legends (TM) Client',
    endT: '18:40:00',
  },
  {
    t: '18:40:00',
    ctx: 'evening',
    repo: null,
    type: 'system.window.focus',
    app: 'League of Legends',
    title: 'League of Legends',
    endT: '19:15:00',
  },
];

export const gs11 = buildSession({
  id: 'gs-11-off-hours-drift',
  name: 'Off-hours drift',
  description:
    'An afternoon on a CSV importer, then three hours of League of Legends. The engine used to file the entire evening under the afternoon’s project, because unlabelled activity kept extending the very window that decided whether it was nearby.',
  tests:
    'A long run of anchorless activity must not be absorbed by the last context that had anchors. Drift is measured from the last real evidence, not from whatever the context most recently swallowed — so the evening forms its own context instead of inflating the afternoon’s. An engine that merges these reports hours of work that never happened, which is the one thing a tool people trust for their own history cannot do.',
  day: '2026-08-28',
  tzOffsetMinutes: 120,
  defaultRepo: 'mimiq',
  contexts: {
    importer: {
      label: 'CSV importer',
      labelMatches: '(?i)importer|csv|mimiq',
      outcome: 'fix_implemented',
      expectedNextStep: 'Push feat/csv-importer',
      note: 'Ends at the commit. Nothing after 16:12 belongs to it.',
    },
    evening: {
      label: 'Evening, not work',
      labelMatches: '(?i)league|legends|discord',
      outcome: 'abandoned',
      note: 'Carries no anchors by construction. It must stand on its own rather than join the afternoon.',
    },
  },
  steps: s,
});
