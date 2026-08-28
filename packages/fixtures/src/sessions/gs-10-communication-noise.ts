import { buildSession, type Step } from '../authoring.js';

/**
 * The cross-app twin of GS-02 (ADR 0002).
 *
 * GS-02 tested that a Slack excursion does not split a coding context. This tests the harder case:
 * the main work *already uses Slack and Mail*, so the interruptions arrive in applications the
 * context legitimately contains. Application identity cannot separate them — only subject matter can.
 */
const s: Step[] = [
  {
    t: '14:00:00',
    ctx: 'projectalpha',
    app: 'com.linear',
    type: 'system.window.focus',
    title: 'ALP-31 Project Alpha kickoff plan — Linear',
    endT: '14:06:20',
    important: true,
    meta: { bundleId: 'com.linear' },
  },
  {
    t: '14:06:30',
    ctx: 'projectalpha',
    app: 'com.tinyspeck.slackmacgap',
    type: 'system.window.focus',
    title: 'danim — #project-alpha — Slack',
    endT: '14:12:40',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.tinyspeck.slackmacgap' },
    note: 'Slack is part of the real work here — which is exactly what makes the later Slack interruption hard.',
  },
  {
    t: '14:12:50',
    ctx: 'projectalpha',
    app: 'com.figma.Desktop',
    type: 'system.window.focus',
    title: 'Project Alpha — wireframes — Figma',
    endT: '14:21:00',
    important: true,
    meta: { bundleId: 'com.figma.Desktop' },
  },
  {
    t: '14:21:10',
    ctx: 'projectalpha',
    app: 'com.apple.Notes',
    type: 'system.window.focus',
    title: 'Project Alpha kickoff — Notes',
    endT: '14:27:30',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.apple.Notes' },
  },

  // ── Interruption 1: Slack, same application as the real work, different subject. ─────────────
  {
    t: '14:27:40',
    ctx: null,
    app: 'com.tinyspeck.slackmacgap',
    type: 'system.window.focus',
    title: 'danim — #random — déjeuner vendredi — Slack',
    endT: '14:29:50',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.tinyspeck.slackmacgap' },
    note: 'Two minutes, same app as the context uses. Only the subject distinguishes it.',
  },

  {
    t: '14:30:00',
    ctx: 'projectalpha',
    app: 'com.figma.Desktop',
    type: 'system.window.focus',
    title: 'Project Alpha — wireframes — Figma',
    endT: '14:38:20',
    meta: { bundleId: 'com.figma.Desktop' },
  },
  {
    t: '14:38:30',
    ctx: 'projectalpha',
    app: 'com.acme.cockpit',
    type: 'system.window.focus',
    title: 'Project Alpha — Cockpit',
    endT: '14:41:00',
    meta: { bundleId: 'com.acme.cockpit' },
  },
  {
    t: '14:39:10',
    ctx: 'projectalpha',
    app: 'com.acme.cockpit',
    type: 'external.mission.started',
    important: true,
    meta: {
      source: 'cockpit',
      missionId: 'msn_7710',
      mission: 'Project Alpha scaffolding',
      project: 'project-alpha',
      anchors: [
        { type: 'issue', value: 'ALP-31' },
        { type: 'project', value: 'project-alpha' },
      ],
    },
  },

  // ── Interruption 2: Mail, unrelated. ─────────────────────────────────────────────────────────
  {
    t: '14:41:10',
    ctx: null,
    app: 'com.apple.mail',
    type: 'system.window.focus',
    title: 'Votre commande a été expédiée — Mail',
    endT: '14:43:20',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.apple.mail' },
  },
  {
    t: '14:43:30',
    ctx: null,
    app: 'com.google.Chrome',
    type: 'system.window.focus',
    title: 'Suivi de colis — Chronopost',
    endT: '14:45:10',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.google.Chrome' },
  },
  {
    t: '14:43:45',
    ctx: null,
    app: 'com.google.Chrome',
    type: 'browser.navigation',
    privacyLevel: 'sensitive',
    meta: {
      tabId: 501,
      url: 'https://www.chronopost.fr/tracking-no-cms/suivi-page',
      host: 'chronopost.fr',
      transition: 'link',
      incognito: false,
    },
  },

  // ── Straight back to Project Alpha. ──────────────────────────────────────────────────────────
  {
    t: '14:45:20',
    ctx: 'projectalpha',
    app: 'com.apple.Terminal',
    type: 'system.window.focus',
    title: 'claude — project-alpha — Terminal',
    endT: '15:02:00',
    repo: 'project-alpha',
    meta: { bundleId: 'com.apple.Terminal' },
  },
  {
    t: '14:45:40',
    ctx: 'projectalpha',
    type: 'agent.session.started',
    important: true,
    repo: 'project-alpha',
    meta: {
      agent: 'claude-code',
      model: 'claude-opus-5',
      projectPath: '/Users/jordan/dev/project-alpha',
    },
  },
  {
    t: '14:56:20',
    ctx: 'projectalpha',
    type: 'agent.activity',
    repo: 'project-alpha',
    meta: {
      agent: 'claude-code',
      toolCallCount: 18,
      filesTouched: ['src/app/layout.tsx', 'src/app/page.tsx'],
      outcome: 'in_progress',
    },
  },

  // ── Interruption 3: Slack again, unrelated, slightly longer. ─────────────────────────────────
  {
    t: '15:02:10',
    ctx: null,
    app: 'com.tinyspeck.slackmacgap',
    type: 'system.window.focus',
    title: 'danim — #général — annonce RH — Slack',
    endT: '15:05:40',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.tinyspeck.slackmacgap' },
  },

  {
    t: '15:05:50',
    ctx: 'projectalpha',
    app: 'com.apple.Terminal',
    type: 'system.window.focus',
    title: 'pnpm dev — project-alpha — Terminal',
    endT: '15:12:00',
    repo: 'project-alpha',
    meta: { bundleId: 'com.apple.Terminal' },
  },
  {
    t: '15:06:20',
    ctx: 'projectalpha',
    type: 'terminal.command',
    important: true,
    repo: 'project-alpha',
    meta: {
      commandRedacted: 'pnpm dev',
      cwd: '/Users/jordan/dev/project-alpha',
      exitCode: 0,
      durationMs: 2300,
      shell: 'zsh',
    },
  },
  {
    t: '15:12:10',
    ctx: 'projectalpha',
    app: 'com.google.Chrome',
    type: 'system.window.focus',
    title: 'Project Alpha (localhost:3000)',
    endT: '15:19:30',
    repo: 'project-alpha',
    meta: { bundleId: 'com.google.Chrome' },
  },
  {
    t: '15:12:30',
    ctx: 'projectalpha',
    app: 'com.google.Chrome',
    type: 'browser.navigation',
    repo: 'project-alpha',
    meta: {
      tabId: 502,
      url: 'http://localhost:3000/',
      host: 'localhost',
      transition: 'typed',
      incognito: false,
    },
  },
  {
    t: '15:19:40',
    ctx: 'projectalpha',
    app: 'com.linear',
    type: 'system.window.focus',
    title: 'ALP-31 Project Alpha kickoff plan — In Progress — Linear',
    endT: '15:24:00',
    important: true,
    meta: { bundleId: 'com.linear' },
  },
  {
    t: '15:22:40',
    ctx: 'projectalpha',
    type: 'manual.note',
    important: true,
    meta: {
      text: 'Scaffolding Alpha en place. Prochaine étape : brancher le design Figma sur le layout.',
    },
  },
];

export const gs10 = buildSession({
  id: 'gs-10-communication-noise',
  name: 'Communication noise',
  description:
    'Eighty minutes on Project Alpha, punctuated by three short unrelated interruptions that arrive in the same applications the real work uses.',
  tests:
    'The cross-app twin of GS-02, and harder: the context legitimately contains Slack and Mail, so the interruptions cannot be separated by application. Only subject matter distinguishes "#project-alpha" from "#random — déjeuner vendredi". Project Alpha must survive as one context. The interruptions may be dropped as noise, isolated as micro-contexts, or attached elsewhere — any of those is acceptable — but they must not fragment the main context.',
  day: '2026-04-17',
  tzOffsetMinutes: 120,
  defaultRepo: null,
  contexts: {
    projectalpha: {
      label: 'Project Alpha kickoff (ALP-31)',
      labelMatches: '(?i)project ?alpha|ALP-31',
      outcome: 'unresolved',
      expectedNextStep: 'Wire the Figma design into the layout',
      note: 'Three interruptions inside it, two of them in applications the context itself uses.',
    },
  },
  steps: s,
});
