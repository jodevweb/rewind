/**
 * Capture probe — real window activity, on Windows and macOS.
 *
 * NOT the collector. The product's collector is Rust behind `ActiveWindowProvider` (ADR 0002 D-11),
 * event-driven, writing to SQLite. This is a measurement rig with one job: feed the engine **real
 * window titles**, so anchor extraction is validated against reality rather than against fixtures we
 * wrote ourselves — the risk flagged in P0-005.
 *
 * It obeys the product's own rules despite being throwaway: exclusions applied before an event is
 * constructed (PRIVACY §3.1), every title through the fail-closed redactor (PRIVACY §4.2), data in
 * the OS data directory, nothing sent anywhere.
 *
 *   pnpm capture         start capturing (Ctrl-C to stop)
 *   pnpm capture:where   print where the data lives, and how much of it there is
 *   pnpm capture:clear   delete it, for real
 */

import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRedactor } from '@rewind/protocol';

import { appendEvent, dataDir, ensureDir, readDay, totals, workDay } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--where')) {
  const { days, events, bytes } = totals();
  console.log(
    [
      '',
      '  Tes données sont ici :',
      `    ${dataDir()}`,
      '',
      `  ${days} jour(s) · ${events} événements · ${(bytes / 1024).toFixed(1)} Ko`,
      "  Un fichier JSONL par jour, en ajout seul. Rien n'est jamais réécrit à l'aveugle.",
      '',
    ].join('\n'),
  );
  process.exit(0);
}

if (process.argv.includes('--clear')) {
  // Real deletion, and only on an explicit request (PRIVACY §10).
  rmSync(dataDir(), { recursive: true, force: true });
  console.log(`Données de capture supprimées : ${dataDir()}`);
  process.exit(0);
}

/** Shipped exclusion defaults (PRIVACY §3.2). An excluded app produces no event at all. */
const EXCLUDED_APPS = [
  '1password',
  'bitwarden',
  'keepass',
  'lastpass',
  'dashlane',
  'signal',
  'whatsapp',
  'telegram',
  'credentialuibroker',
  'lockapp',
  'consent',
  'securityhealthhost',
];

const EXCLUDED_TITLE = /\b(password|mot de passe|bank|banque|login|sign in|connexion)\b/i;

/** Shell chrome, not work. */
const IGNORED_APPS = [
  'searchhost',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'textinputhost',
  'lockapp',
];

/** Apps whose titles are ordinary work signal rather than sensitive (PRIVACY §3.3). */
const SAFE_TITLE_APPS = [
  'code',
  'cursor',
  'windsurf',
  'windowsterminal',
  'powershell',
  'pwsh',
  'cmd',
  'chrome',
  'msedge',
  'firefox',
  'com.microsoft.vscode',
  'com.google.chrome',
  'com.apple.terminal',
  'com.googlecode.iterm2',
];

interface ProbeLine {
  t: number;
  kind: 'focus' | 'idle';
  pid?: number;
  /** Windows: process name. macOS: bundle identifier — the stable identity (ADR 0002 D-11). */
  exe?: string;
  appDisplay?: string;
  title?: string;
  idleMs: number;
}

interface CapturedEvent {
  id: string;
  ref: string;
  timestamp: number;
  endTimestamp?: number;
  tzOffsetMinutes: number;
  source: 'system';
  type: string;
  producer: { name: string; version: string };
  app: string;
  appDisplay: string;
  title?: string;
  metadata: Record<string, unknown>;
  privacyLevel: 'normal' | 'sensitive';
  redaction: { patternsVersion: string; applied: string[]; count: number };
  importance: number;
}

const tz = -new Date().getTimezoneOffset();
const today = workDay(Date.now(), tz);

/** Today's events, read back from disk so a restart continues rather than truncates. */
const events: CapturedEvent[] = readDay<CapturedEvent>(today).events;
const resumedFrom = events.length;

let open: CapturedEvent | null = null;
let dropped = 0;
let redactedCount = 0;
let brief = 0;
let dirty = false;
let seq = 0;

function uuid(): string {
  seq += 1;
  return `0192cap0-0000-7000-8000-${String(Date.now() % 1e9).padStart(9, '0')}${String(seq % 1000).padStart(3, '0')}`;
}

/**
 * Close the currently focused span.
 *
 * An earlier version DELETED spans shorter than five seconds as "glances". That was wrong, and the
 * user caught it: open something, leave it, and it vanished from the timeline. Noise reduction is a
 * display concern, not a capture concern — the log has to be complete for statistics to mean
 * anything later. Short spans are kept and scored low so the UI can de-emphasise them.
 */
function closeOpen(at: number): void {
  if (!open) return;
  const end = Math.max(at, open.timestamp);
  const ms = end - open.timestamp;
  open.endTimestamp = end;
  open.importance = ms < 5000 ? 5 : ms < 60_000 ? 15 : 30;
  if (ms < 5000) brief += 1;
  open = null;
  dirty = true;
}

/**
 * Titles carrying a spinner, a progress counter or an activity glyph change every second — a
 * terminal running an agent is the worst offender. Compare on the stable part of the title, the
 * real-world form of the title-churn coalescing rule in EVENT_MODEL §5.
 */
const CHURN = /[ -㌀\u{1F000}-\u{1FAFF}←-⇿■-◿☀-➿]/gu;

function titleKey(exe: string, title: string): string {
  const stable = title
    .replace(CHURN, '')
    .replace(/\(\d+[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${exe}|${stable}`;
}

let lastKey = '';

function onFocus(line: ProbeLine): void {
  const exe = (line.exe ?? 'unknown').toLowerCase();
  const title = line.title ?? '';

  const key = titleKey(exe, title);
  if (key === lastKey) return;
  lastKey = key;

  closeOpen(line.t);

  if (IGNORED_APPS.includes(exe)) return;
  if (EXCLUDED_APPS.some((a) => exe.includes(a)) || EXCLUDED_TITLE.test(title)) {
    dropped += 1;
    return;
  }
  if (title.trim() === '') return;

  // Fail closed: if redaction cannot complete, the event is dropped, never stored.
  const red = defaultRedactor.redactText(title);
  if (!red.ok) {
    dropped += 1;
    return;
  }
  if (red.stamp.count > 0) redactedCount += red.stamp.count;

  const event: CapturedEvent = {
    id: uuid(),
    ref: `cap-${today}-${String(events.length + 1).padStart(4, '0')}`,
    timestamp: line.t,
    tzOffsetMinutes: tz,
    source: 'system',
    type: 'system.window.focus',
    producer: { name: 'rewind-capture-probe', version: '0.0.2' },
    app: exe,
    appDisplay: line.appDisplay ?? line.exe ?? exe,
    title: red.text,
    metadata: { pid: line.pid, bundleId: exe },
    privacyLevel: SAFE_TITLE_APPS.includes(exe) ? 'normal' : 'sensitive',
    redaction: red.stamp,
    importance: 30,
  };
  events.push(event);
  open = event;
  // Written immediately, one line. A crash costs the span's end time, never the event.
  appendEvent(today, event);
}

/**
 * End timestamps and importance are corrections that arrive after the append. Rather than rewriting
 * history blindly, the day file is rebuilt from the in-memory list only when a correction happened,
 * through a temporary file and a rename — so an interrupted rewrite can never truncate a day.
 */
function compactDay(): void {
  if (!dirty) return;
  dirty = false;
  const dir = ensureDir();
  const target = join(dir, `${today}.jsonl`);
  const tmp = `${target}.tmp`;
  const body = events.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(tmp, body + '\n', 'utf8');
  renameSync(tmp, target);
}

const SNAPSHOT_DIR = resolve(here, '../../studio/public/captured');
const SNAPSHOT = resolve(SNAPSHOT_DIR, 'session.json');

/**
 * A derived view for the studio to fetch. Deliberately NOT the record of truth — deleting it loses
 * nothing, because the JSONL day files in the data directory hold everything.
 */
function flush(): void {
  compactDay();
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const session = {
    $comment: `Vue dérivée. La source est ${dataDir()} — un JSONL par jour, en ajout seul.`,
    id: 'captured-session',
    name: `Capturé — ${today}`,
    description: `Activité réelle capturée le ${today}.`,
    tests: 'Valide l’extraction d’ancres sur de vrais titres de fenêtres.',
    day: today,
    tzOffsetMinutes: tz,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events,
  };
  writeFileSync(SNAPSHOT, JSON.stringify(session, null, 2) + '\n');
}

/**
 * Platform sources. The consumer below is identical on both, which is the point: the probe shows the
 * pipeline is genuinely platform-agnostic before any of it is written in Rust.
 */
const isMac = process.platform === 'darwin';

type LineSink = (line: ProbeLine) => void;

function startWindows(sink: LineSink): () => void {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(here, 'foreground.ps1'),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  createInterface({ input: child.stdout }).on('line', (raw) => {
    try {
      sink(JSON.parse(raw) as ProbeLine);
    } catch {
      // A probe must never die on one bad line.
    }
  });
  return () => child.kill();
}

function startMac(sink: LineSink): () => void {
  let warned = false;
  let sawTitle = false;
  let ticks = 0;

  const timer = setInterval(() => {
    const child = spawn('osascript', [resolve(here, 'foreground.applescript')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('close', () => {
      ticks += 1;
      if (err.trim() !== '') {
        // -1743 is macOS saying Accessibility has not been granted (blocker B-1).
        if (/-1743|not allowed|assistive/i.test(err) && !warned) {
          warned = true;
          console.log(
            [
              '',
              "  Accessibility n'est pas accordée, les titres de fenêtres sont indisponibles.",
              '  Réglages Système → Confidentialité et sécurité → Accessibilité → active ton terminal.',
              "  REWIND ne prend aucune capture d'écran et ne demande jamais l'enregistrement d'écran.",
              '',
            ].join('\n'),
          );
        }
        return;
      }
      const [bundleId = '', appName = '', title = ''] = out.trim().split('\t');
      if (bundleId === '') return;
      if (title !== '') sawTitle = true;
      if (!sawTitle && ticks === 20 && !warned) {
        warned = true;
        console.log(
          [
            '',
            "  Vingt relevés avec un nom d'application mais jamais de titre de fenêtre — c'est",
            '  exactement ce à quoi ressemble une permission Accessibility manquante.',
            '',
          ].join('\n'),
        );
      }
      sink({ t: Date.now(), kind: 'focus', exe: bundleId, appDisplay: appName, title, idleMs: 0 });
    });
  }, 1000);

  return () => clearInterval(timer);
}

const onLine: LineSink = (line) => {
  if (line.kind === 'focus') {
    onFocus(line);
  } else if (open) {
    // Idle means the user stopped interacting, NOT that the window changed — it is still focused.
    // Closing the span here destroyed it in an earlier version, because the span had zero elapsed
    // length. Record the idleness and leave the span open; only a focus change closes one.
    open.metadata['idleMsAtLastHeartbeat'] = line.idleMs;
  }

  flush();
  process.stdout.write(
    `\r● ${events.length} événements · ${brief} brefs · ${dropped} exclus · ${redactedCount} masqués   `,
  );
};

const stopSource = isMac ? startMac(onLine) : startWindows(onLine);

const stop = () => {
  closeOpen(Date.now());
  flush();
  const { days, events: total, bytes } = totals();
  console.log(
    [
      '',
      '',
      `Arrêté. ${events.length} événement(s) aujourd'hui, dont ${brief} très bref(s).`,
      `${dropped} exclus par les règles de confidentialité · ${redactedCount} valeurs masquées.`,
      '',
      `Conservé : ${total} événements sur ${days} jour(s) · ${(bytes / 1024).toFixed(1)} Ko`,
      `  ${dataDir()}`,
      '',
      "Ouvre http://localhost:5273 et choisis l'entrée ●.",
      '',
    ].join('\n'),
  );
  stopSource();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  [
    resumedFrom > 0 ? `  Reprise de ${resumedFrom} événement(s) déjà capturés aujourd'hui.` : '',
    '● Capture en cours. Utilise ta machine normalement.',
    "  Exclus : gestionnaires de mots de passe, fenêtres bancaires et d'authentification.",
    '  Les titres sont masqués avant écriture.',
    `  Données : ${dataDir()}`,
    '  Un JSONL par jour, en ajout seul — rien n’est perdu au redémarrage.',
    '  Ctrl-C pour arrêter · pnpm capture:where pour retrouver tes données',
    '',
  ]
    .filter(Boolean)
    .join('\n'),
);
