import { buildSession, type Step } from '../authoring.js';

const s: Step[] = [
  {
    t: '14:00:00',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'Code.exe',
    title: 'myapp — Visual Studio Code',
    endT: '14:01:10',
  },
  {
    t: '14:00:04',
    ctx: 'flaky',
    type: 'ide.workspace.opened',
    meta: { workspacePath: 'C:/dev/myapp', ideName: 'vscode', ideVersion: '1.96.0' },
  },
  {
    t: '14:00:20',
    ctx: 'flaky',
    type: 'git.status.summary',
    meta: { branch: 'main', dirtyFiles: 0, ahead: 0, behind: 0 },
  },

  {
    t: '14:01:10',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'chrome.exe',
    title: 'Run failed: CI · acme/myapp',
    endT: '14:04:30',
  },
  {
    t: '14:01:20',
    ctx: 'flaky',
    type: 'browser.navigation',
    app: 'chrome.exe',
    title: 'Run failed: CI · acme/myapp',
    important: true,
    meta: {
      tabId: 61,
      url: 'https://github.com/acme/myapp/actions/runs/8812441',
      host: 'github.com',
      transition: 'link',
      incognito: false,
    },
  },
  {
    t: '14:03:05',
    ctx: 'flaky',
    type: 'browser.navigation',
    app: 'chrome.exe',
    title: 'test (windows-latest) · CI · acme/myapp',
    meta: {
      tabId: 61,
      url: 'https://github.com/acme/myapp/actions/runs/8812441/job/24118',
      host: 'github.com',
      transition: 'link',
      incognito: false,
    },
  },

  {
    t: '14:04:30',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'Code.exe',
    title: 'queue.worker.test.ts — myapp — Visual Studio Code',
    endT: '14:09:00',
  },
  {
    t: '14:04:45',
    ctx: 'flaky',
    type: 'ide.file.opened',
    important: true,
    meta: {
      path: 'C:/dev/myapp/test/queue.worker.test.ts',
      languageId: 'typescript',
      repoRelativePath: 'test/queue.worker.test.ts',
    },
  },
  {
    t: '14:06:10',
    ctx: 'flaky',
    type: 'ide.file.opened',
    meta: {
      path: 'C:/dev/myapp/src/queue/worker.ts',
      languageId: 'typescript',
      repoRelativePath: 'src/queue/worker.ts',
    },
  },
  {
    t: '14:08:20',
    ctx: 'flaky',
    type: 'ide.file.saved',
    meta: {
      path: 'C:/dev/myapp/test/queue.worker.test.ts',
      languageId: 'typescript',
      changedLines: 5,
    },
  },

  {
    t: '14:09:00',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'WindowsTerminal.exe',
    title: 'pwsh — myapp',
    endT: '14:09:50',
  },
  {
    t: '14:09:10',
    ctx: 'flaky',
    type: 'terminal.command',
    important: true,
    meta: {
      commandRedacted: 'pnpm vitest run queue --repeat 20',
      cwd: 'C:/dev/myapp',
      exitCode: 1,
      durationMs: 38200,
      shell: 'pwsh',
    },
  },
  {
    t: '14:09:48',
    ctx: 'flaky',
    type: 'terminal.error_tail',
    important: true,
    meta: {
      lines: ['3 of 20 runs failed', 'Timeout: worker did not drain within 500ms'],
      lineCount: 2,
      truncated: false,
    },
  },

  // ── The interruption. Four minutes, unrelated, then straight back. ──────────────────────────
  {
    t: '14:09:50',
    ctx: null,
    type: 'system.window.focus',
    app: 'slack.exe',
    title: 'acme — #general — Slack',
    endT: '14:12:40',
    privacyLevel: 'sensitive',
    note: 'Interruption begins. Different app, no repository, no file overlap.',
  },
  {
    t: '14:11:30',
    ctx: null,
    type: 'system.window.focus',
    app: 'chrome.exe',
    title: 'Team offsite — venue options — Google Docs',
    endT: '14:13:50',
    repo: null,
    privacyLevel: 'sensitive',
  },
  {
    t: '14:11:40',
    ctx: null,
    type: 'browser.navigation',
    app: 'chrome.exe',
    title: 'Team offsite — venue options — Google Docs',
    repo: null,
    privacyLevel: 'sensitive',
    meta: {
      tabId: 70,
      url: 'https://docs.google.com/document/d/1a2b3c',
      host: 'docs.google.com',
      transition: 'link',
      incognito: false,
    },
  },
  {
    t: '14:13:20',
    ctx: null,
    type: 'browser.tab.closed',
    app: 'chrome.exe',
    repo: null,
    meta: { tabId: 70, dwellMs: 100000 },
    note: 'Interruption ends after 4 minutes. Total excursion is under EXCURSION_MAX (5 min).',
  },

  // ── Back to exactly the same work. ─────────────────────────────────────────────────────────
  {
    t: '14:13:50',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'Code.exe',
    title: 'worker.ts — myapp — Visual Studio Code',
    endT: '14:22:00',
  },
  {
    t: '14:14:20',
    ctx: 'flaky',
    type: 'ide.file.saved',
    important: true,
    meta: { path: 'C:/dev/myapp/src/queue/worker.ts', languageId: 'typescript', changedLines: 11 },
    note: 'Same file set as before the interruption. Strong evidence this is the same context.',
  },
  {
    t: '14:17:40',
    ctx: 'flaky',
    type: 'ide.file.saved',
    meta: {
      path: 'C:/dev/myapp/test/queue.worker.test.ts',
      languageId: 'typescript',
      changedLines: 7,
    },
  },
  {
    t: '14:20:10',
    ctx: 'flaky',
    type: 'ide.diagnostic.error',
    meta: {
      path: 'C:/dev/myapp/src/queue/worker.ts',
      line: 47,
      severity: 'error',
      code: 'TS2345',
      messageRedacted:
        "Argument of type 'number' is not assignable to parameter of type 'AbortSignal'.",
    },
  },
  {
    t: '14:21:30',
    ctx: 'flaky',
    type: 'ide.file.saved',
    meta: { path: 'C:/dev/myapp/src/queue/worker.ts', languageId: 'typescript', changedLines: 3 },
  },

  {
    t: '14:22:00',
    ctx: 'flaky',
    type: 'system.window.focus',
    app: 'WindowsTerminal.exe',
    title: 'pwsh — myapp',
    endT: '14:23:10',
  },
  {
    t: '14:22:10',
    ctx: 'flaky',
    type: 'terminal.command',
    important: true,
    meta: {
      commandRedacted: 'pnpm vitest run queue --repeat 20',
      cwd: 'C:/dev/myapp',
      exitCode: 0,
      durationMs: 41100,
      shell: 'pwsh',
    },
  },
  {
    t: '14:23:00',
    ctx: 'flaky',
    type: 'terminal.command',
    meta: {
      commandRedacted: 'git add -A',
      cwd: 'C:/dev/myapp',
      exitCode: 0,
      durationMs: 180,
      shell: 'pwsh',
    },
  },
  {
    t: '14:23:10',
    ctx: 'flaky',
    type: 'git.commit',
    important: true,
    meta: {
      sha: 'c41d7e9a2b6f8c3d5e1a9f7b4c2d8e6a3f1b5c9d',
      messageRedacted:
        'fix(queue): await worker drain with an abort signal instead of a fixed timeout',
      filesChanged: ['src/queue/worker.ts', 'test/queue.worker.test.ts'],
      insertions: 18,
      deletions: 11,
      authorIsUser: true,
    },
  },
  {
    t: '14:24:00',
    ctx: 'flaky',
    type: 'terminal.command',
    meta: {
      commandRedacted: 'git push',
      cwd: 'C:/dev/myapp',
      exitCode: 0,
      durationMs: 1900,
      shell: 'pwsh',
    },
  },
];

export const gs02 = buildSession({
  id: 'gs-02-temporary-interruption',
  name: 'Temporary interruption',
  description:
    'A developer chases a flaky CI test, is pulled into Slack and an unrelated document for four minutes, then returns to exactly the same files.',
  tests:
    'A short excursion must not split the context. This is the false-split case: an engine that opens a new context on every application change, or on any gap, fails here. The Slack and Docs events are ground-truth noise — isolating or dropping them is fine, but the surrounding work must remain one context.',
  day: '2026-03-16',
  tzOffsetMinutes: 60,
  defaultRepo: 'myapp',
  contexts: {
    flaky: {
      label: 'Flaky queue worker test',
      labelMatches: '(?i)queue|worker|flaky|test',
      outcome: 'fix_implemented',
      expectedNextStep: 'Confirm CI passes on the pushed branch',
      note: 'Spans the interruption. Before and after must land in the same context.',
    },
  },
  steps: s,
});
