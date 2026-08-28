#!/usr/bin/env node
/**
 * Forbidden API check — ticket P0-008.
 *
 * PRIVACY.md §2 promises that REWIND never captures keystrokes or clipboard content, under any
 * setting. A promise enforced only by policy is a promise that erodes. This turns it into a build
 * gate: if any of these APIs appears anywhere in the tree, CI fails.
 *
 * Run: node scripts/check-forbidden-apis.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const FORBIDDEN = [
  // Keyboard hooks — Windows
  { pattern: 'SetWindowsHookEx', reason: 'keyboard/mouse hook (PRIVACY.md §2: no keylogger)' },
  { pattern: 'WH_KEYBOARD', reason: 'keyboard hook constant' },
  { pattern: 'WH_KEYBOARD_LL', reason: 'low-level keyboard hook constant' },
  { pattern: 'GetAsyncKeyState', reason: 'polls raw key state' },
  { pattern: 'GetKeyboardState', reason: 'reads raw key state' },
  { pattern: 'RegisterRawInputDevices', reason: 'raw keyboard input' },
  // Keyboard hooks — macOS
  { pattern: 'CGEventTap', reason: 'macOS event tap can read keystrokes' },
  { pattern: 'IOHIDManager', reason: 'raw HID input' },
  // Keyboard hooks — Linux / X11
  { pattern: 'XRecordCreateContext', reason: 'X11 input recording' },
  // Clipboard (PRIVACY.md §2: clipboard is never read)
  { pattern: 'GetClipboardData', reason: 'clipboard read' },
  { pattern: 'NSPasteboard', reason: 'clipboard read' },
  { pattern: 'clipboard.readText', reason: 'clipboard read' },
  { pattern: 'navigator.clipboard.read', reason: 'clipboard read' },
  // Accessibility text reading (ADR 0005 D-35). REWIND observes that a text element changed; it
  // never asks what the value became. Reading a field while the user types is functionally a
  // keylogger even without a keyboard hook — §8 bans the outcome, not the API.
  { pattern: 'kAXValueAttribute', reason: 'reads text content via accessibility (ADR 0005 D-35)' },
  { pattern: 'kAXSelectedTextAttribute', reason: 'reads selected text via accessibility' },
  { pattern: 'kAXSelectedTextRangeAttribute', reason: 'reads selection range via accessibility' },
  {
    pattern: 'AXUIElementCopyAttributeValue',
    reason: 'generic accessibility value read — use the role-scoped helper instead',
  },
  {
    pattern: 'CurrentValuePattern',
    reason: 'reads text content via UI Automation (Windows equivalent)',
  },
  { pattern: 'TextPattern', reason: 'reads text content via UI Automation' },
  // Screen capture (PRIVACY.md §2: no screenshots at MVP)
  { pattern: 'BitBlt', reason: 'screen capture' },
  { pattern: 'CGDisplayCreateImage', reason: 'screen capture' },
  { pattern: 'getDisplayMedia', reason: 'screen capture' },
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.turbo',
  'coverage',
  'gen',
]);

// This file necessarily contains every forbidden string, and the documents describe the policy.
const ALLOWLIST = [join('scripts', 'check-forbidden-apis.mjs'), 'docs' + sep];

const SCAN_EXTENSIONS = new Set([
  '.rs',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.toml',
  '.json',
]);

/** @type {{file: string, line: number, pattern: string, reason: string}[]} */
const violations = [];

function isAllowlisted(relPath) {
  return ALLOWLIST.some((prefix) => relPath === prefix || relPath.startsWith(prefix));
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (SKIP_DIRS.has(entry)) continue;
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    if (dot === -1 || !SCAN_EXTENSIONS.has(entry.slice(dot))) continue;
    if (isAllowlisted(rel)) continue;

    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, reason } of FORBIDDEN) {
        if (line.includes(pattern)) {
          violations.push({ file: rel, line: i + 1, pattern, reason });
        }
      }
    });
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error('\nForbidden API usage detected. See PRIVACY.md §2.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.pattern}  — ${v.reason}`);
  }
  console.error(
    '\nThese APIs are not "discouraged". The product promises they are absent, so this build fails.\n',
  );
  process.exit(1);
}

console.log(`Forbidden API check passed (${FORBIDDEN.length} patterns, no violations).`);
