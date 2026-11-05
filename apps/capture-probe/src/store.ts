/**
 * Durable capture store.
 *
 * The first version kept every event in memory and rewrote one JSON file on each flush, inside
 * `apps/studio/public/` — a build directory. Three things wrong with that, and the user was right to
 * ask where their data actually lived:
 *
 *   1. A whole-file rewrite is not crash-safe. Interrupt it and the file is truncated or invalid,
 *      and the history is gone. This is the failure STORAGE.md §6 and §96 exist to prevent.
 *   2. A build directory is not a data directory. `rm -rf dist` or a clean checkout takes it with it.
 *   3. One file for all time means one corruption loses everything, and no day can be read alone.
 *
 * So: **append-only JSONL, one file per day, in the OS data directory.** Appending a single line is
 * as close to atomic as a filesystem gets — a torn write costs at most the last line, and the reader
 * skips unparseable lines by design.
 *
 * This is the bridge, not the destination. The product stores events in SQLite with WAL, retention
 * and compaction (STORAGE.md). JSONL is lossless and append-only, so everything captured now
 * migrates into that store when the Rust daemon exists — nothing recorded today is throwaway.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Follows STORAGE.md §6: the OS data directory, never a synced or build folder. */
export function dataDir(): string {
  const home = homedir();
  if (platform() === 'win32') {
    // LOCALAPPDATA, not APPDATA: roaming profiles and OneDrive corrupt append-heavy files.
    const base = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(base, 'REWIND', 'capture');
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'REWIND', 'capture');
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'rewind', 'capture');
}

/**
 * The work day an instant belongs to, using the 04:00 local cutoff (INITIAL_ANALYSIS TR-8).
 * A 01:30 event belongs to the previous day's work, which is how people actually remember it.
 */
export function workDay(timestamp: number, tzOffsetMinutes: number): string {
  const local = new Date(timestamp + tzOffsetMinutes * 60_000);
  if (local.getUTCHours() < 4) local.setUTCDate(local.getUTCDate() - 1);
  return local.toISOString().slice(0, 10);
}

function fileFor(day: string): string {
  return join(dataDir(), `${day}.jsonl`);
}

export function ensureDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one event. One line, one syscall — the smallest unit the filesystem can tear. */
export function appendEvent(day: string, event: unknown): void {
  ensureDir();
  appendFileSync(fileFor(day), JSON.stringify(event) + '\n', 'utf8');
}

/** Days that have data, oldest first. */
export function listDays(): string[] {
  const dir = dataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort();
}

/**
 * Read one day. Unparseable lines are skipped rather than fatal: a torn final line from an
 * interrupted write must cost that line and nothing else.
 */
export function readDay<T>(day: string): { events: T[]; skipped: number } {
  const path = fileFor(day);
  if (!existsSync(path)) return { events: [], skipped: 0 };
  const events: T[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

export function totals(): { days: number; events: number; bytes: number } {
  const days = listDays();
  let events = 0;
  let bytes = 0;
  for (const day of days) {
    const path = fileFor(day);
    const text = readFileSync(path, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
    events += text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return { days: days.length, events, bytes };
}
