import { buildSession, type Step } from '../authoring.js';

/**
 * Zero development events (ADR 0002).
 *
 * No repository, no branch, no commit, no terminal, no IDE, no agent. If REWIND can still reconstruct
 * this as one coherent piece of work, it is genuinely work-context-first. If it cannot, the pivot has
 * not actually happened in the engine — only in the documents.
 */
const s: Step[] = [
  {
    t: '17:05:00',
    ctx: 'billing',
    app: 'com.apple.mail',
    type: 'system.window.focus',
    title: 'Facture août — Acme — Mail',
    endT: '17:09:40',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.apple.mail' },
    note: 'Subject line only. The message body is never read at Level 1.',
  },
  {
    t: '17:07:20',
    ctx: 'billing',
    app: 'com.apple.mail',
    type: 'system.window.title_changed',
    title: 'Facture août — Acme — pièce jointe — Mail',
    privacyLevel: 'sensitive',
    meta: { previousTitle: 'Facture août — Acme — Mail' },
  },

  {
    t: '17:09:50',
    ctx: 'billing',
    app: 'com.apple.finder',
    type: 'system.window.focus',
    title: 'Téléchargements — Finder',
    endT: '17:12:20',
    important: true,
    meta: { bundleId: 'com.apple.finder', directory: '/Users/dev/Downloads' },
  },
  {
    t: '17:10:40',
    ctx: 'billing',
    app: 'com.apple.finder',
    type: 'system.window.title_changed',
    title: 'Comptabilité — Finder',
    meta: {
      previousTitle: 'Téléchargements — Finder',
      directory: '/Users/dev/Documents/Comptabilité',
    },
    note: 'Finder directory, not a filesystem scan. Metadata the window already exposes.',
  },
  {
    t: '17:11:30',
    ctx: 'billing',
    app: 'com.apple.finder',
    type: 'fs.file.created',
    important: true,
    meta: { path: '/Users/dev/Documents/Comptabilité/facture-aout.pdf', extension: '.pdf' },
    note: 'An authorised, user-chosen folder — never an arbitrary scan.',
  },

  {
    t: '17:12:30',
    ctx: 'billing',
    app: 'com.apple.Preview',
    type: 'system.window.focus',
    title: 'facture-aout.pdf — Aperçu',
    endT: '17:18:10',
    important: true,
    meta: { bundleId: 'com.apple.Preview' },
    note: 'The document name is the anchor. The PDF contents are never read.',
  },

  {
    t: '17:18:20',
    ctx: 'billing',
    app: 'com.google.Chrome',
    type: 'system.window.focus',
    title: 'Espace client — Qonto',
    endT: '17:26:00',
    privacyLevel: 'sensitive',
    meta: { bundleId: 'com.google.Chrome' },
  },
  {
    t: '17:18:40',
    ctx: 'billing',
    app: 'com.google.Chrome',
    type: 'browser.navigation',
    privacyLevel: 'sensitive',
    important: true,
    meta: {
      tabId: 401,
      url: 'https://qonto.com/',
      host: 'qonto.com',
      transition: 'typed',
      incognito: false,
    },
    note: 'A banking domain. In the shipped defaults this host is excluded outright — the fixture keeps it to exercise the sensitive path, and an engine must still form the context without it.',
  },
  {
    t: '17:23:10',
    ctx: 'billing',
    app: 'com.google.Chrome',
    type: 'browser.navigation',
    meta: {
      tabId: 402,
      url: 'https://www.urssaf.fr/portail/home/espace-connecte.html',
      host: 'urssaf.fr',
      transition: 'typed',
      incognito: false,
    },
  },

  {
    t: '17:26:10',
    ctx: 'billing',
    app: 'com.apple.Notes',
    type: 'system.window.focus',
    title: 'Facturation août — Notes',
    endT: '17:33:40',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.apple.Notes' },
  },
  {
    t: '17:31:20',
    ctx: 'billing',
    type: 'manual.note',
    important: true,
    meta: { text: "Facture août envoyée. Reste à déclarer l'URSSAF avant le 15." },
  },

  {
    t: '17:33:50',
    ctx: 'billing',
    app: 'com.apple.mail',
    type: 'system.window.focus',
    title: 'Facture août — Acme — envoyé — Mail',
    endT: '17:38:00',
    privacyLevel: 'sensitive',
    important: true,
    meta: { bundleId: 'com.apple.mail' },
  },
  {
    t: '17:38:10',
    ctx: 'billing',
    app: 'com.apple.finder',
    type: 'system.window.focus',
    title: 'Comptabilité — Finder',
    endT: '17:41:20',
    meta: { bundleId: 'com.apple.finder', directory: '/Users/dev/Documents/Comptabilité' },
  },
  {
    t: '17:40:10',
    ctx: 'billing',
    app: 'com.apple.finder',
    type: 'fs.file.renamed',
    meta: {
      fromPath: '/Users/dev/Documents/Comptabilité/facture-aout.pdf',
      toPath: '/Users/dev/Documents/Comptabilité/2026-08-facture-acme.pdf',
    },
  },
];

export const gs09 = buildSession({
  id: 'gs-09-administrative-work',
  name: 'Administrative work',
  description:
    'Thirty-five minutes of billing admin: an invoice email, a PDF in Finder, a banking portal, the URSSAF site and a note. No development events at all.',
  tests:
    'The fixture that proves REWIND is no longer developer-first. There is no repository, branch, commit, terminal, IDE or agent event — only application titles, one document name, two URLs and a note. Everything the engine has to work with is Level 1 observation plus the recurring anchors "facture", "août" and "Comptabilité". If this fixture scores badly while the developer fixtures score well, the engine is still implicitly built around code.',
  day: '2026-04-16',
  tzOffsetMinutes: 120,
  defaultRepo: null,
  contexts: {
    billing: {
      label: 'August billing and administration',
      labelMatches: '(?i)factur|billing|comptab|august|ao[uû]t|admin',
      outcome: 'unresolved',
      expectedNextStep: 'Declare URSSAF before the 15th',
      note: 'Expected Today entry: "Administration · 36m · Mail → Finder → Browser → Notes".',
    },
  },
  steps: s,
});
