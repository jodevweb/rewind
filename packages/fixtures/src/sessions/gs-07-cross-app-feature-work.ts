import { buildSession, type Step } from '../authoring.js';

/**
 * The pivot fixture (ADR 0002). Nine applications, one piece of work.
 *
 * Every event here is Level 1 — generic macOS application and window observation — except the Claude
 * Code and Cockpit events, which are the two rich sources that actually exist in this workflow. There
 * is no IDE, almost no source file, and the repository signal appears late and briefly.
 *
 * An engine built around `repositoryId` scores near zero on this fixture. That is the point.
 */
const s: Step[] = [
  {
    t: '09:12:00',
    ctx: 'homestaging',
    app: 'com.tinyspeck.slackmacgap',
    type: 'system.window.focus',
    title: 'danim — #product — Slack',
    endT: '09:17:40',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.tinyspeck.slackmacgap' },
    note: 'The work starts in Slack. No repo, no file, no ticket yet — only a window title.',
  },
  {
    t: '09:14:20',
    ctx: 'homestaging',
    app: 'com.tinyspeck.slackmacgap',
    type: 'system.window.title_changed',
    title: 'danim — #product — Home Staging V3 — Slack',
    privacyLevel: 'sensitive',
    meta: { previousTitle: 'danim — #product — Slack' },
    note: 'The anchor "Home Staging" first appears in a window title.',
  },

  {
    t: '09:18:00',
    ctx: 'homestaging',
    app: 'com.linear',
    type: 'system.window.focus',
    title: 'DNM-4218 Home Staging generation flow — Linear',
    endT: '09:23:30',
    important: true,
    meta: { bundleId: 'com.linear' },
    note: 'DNM-4218 — a structured identifier in a native app window title. The strongest anchor available at Level 1.',
  },
  {
    t: '09:21:10',
    ctx: 'homestaging',
    app: 'com.linear',
    type: 'system.window.title_changed',
    title: 'DNM-4218 Home Staging generation flow — In Progress — Linear',
    meta: { previousTitle: 'DNM-4218 Home Staging generation flow — Linear' },
  },

  {
    t: '09:24:00',
    ctx: 'homestaging',
    app: 'com.figma.Desktop',
    type: 'system.window.focus',
    title: 'Home Staging V3 — Figma',
    endT: '09:30:20',
    important: true,
    meta: { bundleId: 'com.figma.Desktop' },
  },
  {
    t: '09:27:40',
    ctx: 'homestaging',
    app: 'com.figma.Desktop',
    type: 'system.window.title_changed',
    title: 'Home Staging V3 / Generation flow — Figma',
    meta: { previousTitle: 'Home Staging V3 — Figma' },
  },

  {
    t: '09:31:00',
    ctx: 'homestaging',
    app: 'com.apple.Notes',
    type: 'system.window.focus',
    title: 'Home Staging thoughts — Notes',
    endT: '09:38:10',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.apple.Notes' },
    note: 'Title only. Note content is never read at Level 1 (PRIVACY §11 of the pivot brief).',
  },

  {
    t: '09:38:40',
    ctx: 'homestaging',
    app: 'com.google.Chrome',
    type: 'system.window.focus',
    title: 'Stable Diffusion inpainting guide — Google Chrome',
    endT: '09:42:00',
    meta: { bundleId: 'com.google.Chrome' },
  },
  {
    t: '09:38:55',
    ctx: 'homestaging',
    app: 'com.google.Chrome',
    type: 'browser.navigation',
    title: 'Inpainting — Stable Diffusion documentation',
    important: true,
    meta: {
      tabId: 210,
      url: 'https://platform.stability.ai/docs/features/inpainting',
      host: 'platform.stability.ai',
      transition: 'typed',
      incognito: false,
    },
  },

  {
    t: '09:42:00',
    ctx: 'homestaging',
    app: 'com.acme.cockpit',
    type: 'system.window.focus',
    title: 'Home Staging — Cockpit',
    endT: '09:44:00',
    meta: { bundleId: 'com.acme.cockpit' },
  },
  {
    t: '09:42:30',
    ctx: 'homestaging',
    app: 'com.acme.cockpit',
    type: 'external.mission.started',
    important: true,
    meta: {
      source: 'cockpit',
      mission: 'Home Staging generation flow',
      missionId: 'msn_8841',
      project: 'home-staging',
      anchors: [
        { type: 'issue', value: 'DNM-4218' },
        { type: 'project', value: 'home-staging' },
      ],
    },
    note: 'Rich Level 2 event over the generic external protocol. Carries anchors explicitly rather than hiding them in a title.',
  },
  {
    t: '09:43:10',
    ctx: 'homestaging',
    app: 'com.acme.cockpit',
    type: 'external.agent.started',
    meta: {
      source: 'cockpit',
      missionId: 'msn_8841',
      agent: 'claude-code',
      worktree: '/Users/jordan/dev/danim-wt/DNM-4218',
    },
  },

  {
    t: '09:44:00',
    ctx: 'homestaging',
    app: 'com.apple.Terminal',
    type: 'system.window.focus',
    title: 'claude — danim-wt/DNM-4218 — Terminal',
    endT: '10:16:00',
    repo: 'danim',
    meta: { bundleId: 'com.apple.Terminal' },
  },
  {
    t: '09:44:20',
    ctx: 'homestaging',
    type: 'agent.session.started',
    important: true,
    repo: 'danim',
    meta: {
      agent: 'claude-code',
      model: 'claude-opus-5',
      projectPath: '/Users/jordan/dev/danim-wt/DNM-4218',
    },
  },
  {
    t: '09:52:40',
    ctx: 'homestaging',
    type: 'agent.activity',
    repo: 'danim',
    meta: {
      agent: 'claude-code',
      toolCallCount: 14,
      filesTouched: ['src/staging/generate.ts', 'src/staging/prompt.ts'],
      outcome: 'in_progress',
    },
  },
  {
    t: '10:04:10',
    ctx: 'homestaging',
    type: 'agent.activity',
    important: true,
    repo: 'danim',
    meta: {
      agent: 'claude-code',
      toolCallCount: 31,
      filesTouched: ['src/staging/generate.ts', 'src/staging/prompt.ts', 'test/staging.test.ts'],
      outcome: 'in_progress',
    },
  },
  {
    t: '10:11:20',
    ctx: 'homestaging',
    type: 'git.branch.checkout',
    repo: 'danim',
    meta: {
      from: 'main',
      to: 'fix/DNM-4218-generation',
      isNewBranch: true,
      worktree: '/Users/jordan/dev/danim-wt/DNM-4218',
    },
    note: 'The only repository signal in the whole session, and it arrives an hour in.',
  },

  {
    t: '10:17:00',
    ctx: 'homestaging',
    app: 'com.apple.Terminal',
    type: 'system.window.focus',
    title: 'pnpm test staging — danim-wt/DNM-4218 — Terminal',
    endT: '10:22:00',
    repo: 'danim',
    meta: { bundleId: 'com.apple.Terminal' },
  },
  {
    t: '10:17:30',
    ctx: 'homestaging',
    type: 'terminal.command',
    important: true,
    repo: 'danim',
    meta: {
      commandRedacted: 'pnpm test staging',
      cwd: '/Users/jordan/dev/danim-wt/DNM-4218',
      exitCode: 1,
      durationMs: 14200,
      shell: 'zsh',
    },
  },
  {
    t: '10:17:45',
    ctx: 'homestaging',
    type: 'terminal.error_tail',
    repo: 'danim',
    meta: {
      lines: ['expected mask to cover 4 regions, got 3', '  at test/staging.test.ts:66:14'],
      lineCount: 2,
      truncated: false,
    },
  },
  {
    t: '10:21:10',
    ctx: 'homestaging',
    type: 'agent.activity',
    important: true,
    repo: 'danim',
    meta: {
      agent: 'claude-code',
      toolCallCount: 9,
      filesTouched: ['src/staging/mask.ts'],
      outcome: 'in_progress',
    },
  },

  {
    t: '10:22:00',
    ctx: 'homestaging',
    app: 'com.acme.cockpit',
    type: 'system.window.focus',
    title: 'Home Staging — run 3 — Cockpit',
    endT: '10:26:00',
    meta: { bundleId: 'com.acme.cockpit' },
  },
  {
    t: '10:22:40',
    ctx: 'homestaging',
    app: 'com.acme.cockpit',
    type: 'external.run.finished',
    important: true,
    meta: {
      source: 'cockpit',
      missionId: 'msn_8841',
      runId: 'run_3',
      status: 'succeeded',
      filesChanged: [
        'src/staging/generate.ts',
        'src/staging/prompt.ts',
        'src/staging/mask.ts',
        'test/staging.test.ts',
      ],
    },
  },

  {
    t: '10:26:20',
    ctx: 'homestaging',
    app: 'com.apple.mail',
    type: 'system.window.focus',
    title: 'Re: Home Staging V3 — retours client — Mail',
    endT: '10:31:00',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.apple.mail' },
    note: 'Mail. Subject line only — never the body (PRIVACY §12 of the pivot brief).',
  },

  {
    t: '10:31:00',
    ctx: 'homestaging',
    app: 'com.linear',
    type: 'system.window.focus',
    title: 'DNM-4218 Home Staging generation flow — In Review — Linear',
    endT: '10:36:00',
    important: true,
    meta: { bundleId: 'com.linear' },
  },
  {
    t: '10:34:20',
    ctx: 'homestaging',
    app: 'com.figma.Desktop',
    type: 'system.window.focus',
    title: 'Home Staging V3 / Generation flow — Figma',
    endT: '10:39:00',
    meta: { bundleId: 'com.figma.Desktop' },
  },
  {
    t: '10:39:00',
    ctx: 'homestaging',
    app: 'com.apple.Notes',
    type: 'system.window.focus',
    title: 'Home Staging thoughts — Notes',
    endT: '10:42:30',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.apple.Notes' },
  },
  {
    t: '10:41:00',
    ctx: 'homestaging',
    type: 'manual.note',
    important: true,
    meta: {
      text: 'Claude a fini la première implémentation de la génération. Reste à relire le masque avant de merger DNM-4218.',
    },
  },
];

export const gs07 = buildSession({
  id: 'gs-07-cross-app-feature-work',
  name: 'Cross-app feature work',
  description:
    'Ninety minutes on one feature, crossing Slack, Linear, Figma, Notes, Chrome, Cockpit, Terminal, Claude Code and Mail. Nine applications, one piece of work.',
  tests:
    'The fixture that proves REWIND is work-context-first rather than developer-first. Almost every event is generic Level 1 window observation; there is no IDE, and the repository appears only after an hour. Grouping must come from anchors — "Home Staging", DNM-4218, the project name — and from temporal and semantic proximity. An engine that leans on repositoryId, workspace or file overlap recovers almost nothing here.',
  day: '2026-04-14',
  tzOffsetMinutes: 120,
  defaultRepo: null,
  contexts: {
    homestaging: {
      label: 'Home Staging V3 (DNM-4218)',
      labelMatches: '(?i)home ?staging|DNM-4218',
      outcome: 'unresolved',
      expectedNextStep: "Review Claude's implementation of the mask before merging DNM-4218",
      note: 'Nine applications, one context. Expected Today entry: "Home Staging V3 · 1h30 · Slack → Linear → Figma → Cockpit → Claude".',
    },
  },
  steps: s,
});
