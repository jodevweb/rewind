/**
 * Capture probe — real window activity on this machine, into the existing engine.
 *
 * NOT the collector. The product's collector is Rust behind `ActiveWindowProvider` (ADR 0002 D-11),
 * event-driven, writing to SQLite. This is a measurement rig with one job: produce **real window
 * titles** so anchor extraction is validated against reality rather than against fixtures we wrote
 * ourselves — the risk flagged in P0-005 and the reason to run it before porting anything to Rust.
 *
 * It obeys the product's own rules even though it is throwaway:
 *   - exclusion rules run before an event is constructed (PRIVACY §3.1);
 *   - every title goes through the secret redactor, fail-closed (PRIVACY §4.2);
 *   - output is one local file, deleted with `pnpm capture:clear`;
 *   - nothing is sent anywhere.
 *
 *   pnpm capture           start capturing (Ctrl-C to stop)
 *   pnpm capture:clear     delete the captured file
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRedactor } from '@rewind/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, '../../studio/public/captured');
const OUT_FILE = resolve(OUT_DIR, 'session.json');

if (process.argv.includes('--clear')) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  console.log('Captured session deleted.');
  process.exit(0);
}

/**
 * Shipped exclusion defaults (PRIVACY §3.2), by process name. An excluded application produces no
 * event at all — not a hidden one.
 */
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

/** Titles matching these never become events either. */
const EXCLUDED_TITLE = /\b(password|mot de passe|bank|banque|login|sign in|connexion)\b/i;

/** Windows shell chrome that is not work. */
const IGNORED_APPS = [
  'searchhost',
  'shellexperiencehost',
  'startmenuexperiencehost',
  'textinputhost',
  'lockapp',
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

/** Applications whose titles are treated as ordinary work signal (PRIVACY §3.3). */
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
];

const events: CapturedEvent[] = [];
let open: CapturedEvent | null = null;
let dropped = 0;
let redactedCount = 0;
const tz = -new Date().getTimezoneOffset();

function uuid(n: number): string {
  return `0192cap0-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function closeOpen(at: number): void {
  if (!open) return;
  // Clamp: an idle heartbeat closes the span at "when input stopped", which can be earlier than the
  // span began. Unclamped that yields a negative duration, the span is treated as a sub-5-second
  // glance, and every heartbeat silently destroyed the event it was meant to close.
  const end = Math.max(at, open.timestamp);
  open.endTimestamp = end;
  const ms = end - open.timestamp;
  // Sub-5-second glances are noise (EVENT_MODEL §5).
  if (ms < 5000) {
    events.pop();
    open = null;
    return;
  }
  open.importance = ms > 60_000 ? 30 : 15;
  open = null;
}

/**
 * Titles carrying a spinner, a progress counter or an activity glyph change every second — a
 * terminal running an agent is the worst offender. Compare on the stable part of the title, which
 * is the real-world version of the title-churn coalescing rule in EVENT_MODEL §5.
 */
const CHURN = /[ -㌀\u{1F000}-\u{1FAFF}←-⇿■-◿☀-➿]/gu;

function titleKey(exe: string, title: string): string {
  const stable = title
    .replace(CHURN, '')
    .replace(/\(\d+[^)]*\)/g, '') // "(3s)", "(12 tools)" and similar live counters
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

  const n = events.length + 1;
  const event: CapturedEvent = {
    id: uuid(n),
    ref: `cap-e${String(n).padStart(4, '0')}`,
    timestamp: line.t,
    tzOffsetMinutes: tz,
    source: 'system',
    type: 'system.window.focus',
    producer: { name: 'rewind-capture-probe', version: '0.0.1' },
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
}

function flush(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const session = {
    $comment:
      'Captured on this machine by the capture probe. Real window titles, redacted. Not committed.',
    id: 'captured-session',
    name: 'Captured (this machine)',
    description: `Real foreground-window activity captured on ${new Date().toISOString().slice(0, 10)}.`,
    tests: 'Validates anchor extraction against real window titles rather than authored fixtures.',
    day: new Date().toISOString().slice(0, 10),
    tzOffsetMinutes: tz,
    // No ground truth: nobody labelled this. The studio shows it as unlabelled.
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events,
  };
  writeFileSync(OUT_FILE, JSON.stringify(session, null, 2) + '\n');
}

/**
 * Platform sources. The consumer below is identical on both, which is the point: the probe proves
 * the pipeline is genuinely platform-agnostic before any of it is written in Rust.
 *
 *   Windows — PowerShell P/Invoke, emits JSON lines directly.
 *   macOS   — osascript polled from here; AppleScript has no loop worth writing.
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
  let warnedNoTitles = false;
  let sawAnyTitle = false;
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
        // -1743 is macOS telling us Accessibility has not been granted (blocker B-1).
        if (/-1743|not allowed|assistive/i.test(err) && !warnedNoTitles) {
          warnedNoTitles = true;
          console.log(
            [
              '',
              '  Accessibility is not granted, so window titles are unavailable.',
              '  System Settings → Privacy & Security → Accessibility → enable your terminal.',
              '  REWIND takes no screenshots and never requests Screen Recording (ADR 0003 D-22).',
              '',
            ].join('\n'),
          );
        }
        return;
      }
      const [bundleId = '', appName = '', title = ''] = out.trim().split('	');
      if (bundleId === '') return;
      if (title !== '') sawAnyTitle = true;
      if (!sawAnyTitle && ticks === 20 && !warnedNoTitles) {
        warnedNoTitles = true;
        console.log(
          [
            '',
            '  Twenty samples with an app name but never a window title — that is exactly what a',
            '  missing Accessibility grant looks like. Enable it for your terminal, then restart.',
            '',
          ].join('\n'),
        );
      }
      sink({
        t: Date.now(),
        kind: 'focus',
        exe: bundleId,
        appDisplay: appName,
        title,
        idleMs: 0,
      });
    });
  }, 1000);

  return () => clearInterval(timer);
}

const onLine: LineSink = (line) => {
  if (line.kind === 'focus') {
    onFocus(line);
  } else if (open) {
    // Idle means the user stopped interacting, NOT that the window changed — it is still focused.
    // Closing the span here destroyed it: the span had zero elapsed length, so the sub-5-second
    // glance rule threw it away. Record the idleness and leave the span open; only a focus change
    // closes one. Idle time is subtracted later, where durations are computed (§69).
    open.metadata['idleMsAtLastHeartbeat'] = line.idleMs;
  }

  flush();
  process.stdout.write(
    `\r● recording · ${events.length} events · ${dropped} excluded · ${redactedCount} redacted   `,
  );
};

const stopSource = isMac ? startMac(onLine) : startWindows(onLine);

const stop = () => {
  closeOpen(Date.now());
  flush();
  console.log(
    `\n\nStopped. ${events.length} events → ${OUT_FILE}\n` +
      `${dropped} excluded by privacy rules · ${redactedCount} values redacted.\n` +
      `Open http://localhost:5273 and pick "Captured (this machine)".\n` +
      `Delete it with: pnpm capture:clear\n`,
  );
  stopSource();
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(
  `● Capture probe running. Use your machine normally.\n` +
    `  Excluded: password managers, banking and auth windows. Titles are redacted before writing.\n` +
    `  Output: ${OUT_FILE}\n` +
    `  Press Ctrl-C to stop.\n`,
);
