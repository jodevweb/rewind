/**
 * Reading REWIND's store from outside the daemon.
 *
 * Read-only, and that is enforced by the connection rather than by intent: this process must never
 * be able to write an event. The daemon owns the file, WAL and all; a second writer is how a store
 * gets corrupted, and an event written by anything but a collector has no redaction stamp and could
 * not be inserted anyway (PRIVACY §4.2).
 *
 * `node:sqlite` is the built-in, so there is no native module to compile and nothing to install.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { DaemonEvent } from '@rewind/shared';

/**
 * `node:sqlite`, required rather than imported.
 *
 * It is a real Node builtin, but it is deliberately left out of `module.builtinModules` — like
 * `node:test` — and every bundler that decides what to externalise from that list therefore tries to
 * resolve it as a file on disk and fails. A static import here makes the test runner unable to load
 * this module at all. The type import above is erased, so the types are still real.
 */
const require = createRequire(import.meta.url);
export const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType;
};

/**
 * Where the daemon keeps its database (STORAGE.md §6). The same three rules as
 * `platform::data_dir`, and they have to stay the same three: a mismatch here reads an empty store
 * and reports, wrongly, that you have never worked.
 */
export function storePath(): string {
  if (process.env['REWIND_DB']) return process.env['REWIND_DB'];
  const home = homedir();
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return join(local, 'REWIND', 'rewind.db');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'REWIND', 'rewind.db');
  }
  const data = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(data, 'rewind', 'rewind.db');
}

const COLUMNS =
  'timestamp, end_timestamp, tz_offset_minutes, source, type, app_id, app_display, title, pid, ' +
  'metadata, redaction_version, redaction_applied, redaction_count, importance';

interface Row {
  timestamp: number;
  end_timestamp: number | null;
  tz_offset_minutes: number;
  source: string;
  type: string;
  app_id: string;
  app_display: string;
  title: string | null;
  pid: number | null;
  metadata: string | null;
  redaction_version: string;
  redaction_applied: string;
  redaction_count: number;
  importance: number;
}

const toEvent = (row: Row): DaemonEvent => ({
  timestamp: row.timestamp,
  endTimestamp: row.end_timestamp,
  tzOffsetMinutes: row.tz_offset_minutes,
  source: row.source,
  type: row.type,
  appId: row.app_id,
  appDisplay: row.app_display,
  title: row.title ?? '',
  pid: row.pid,
  metadata: row.metadata ?? '{}',
  redactionVersion: row.redaction_version,
  redactionApplied: row.redaction_applied ? row.redaction_applied.split(',') : [],
  redactionCount: row.redaction_count,
  importance: row.importance,
});

export interface DaySummary {
  day: string;
  count: number;
  first: number;
  last: number;
}

export class Store {
  private db: DatabaseSyncType;

  constructor(path = storePath()) {
    if (!existsSync(path)) {
      throw new Error(
        `REWIND: no store at ${path}. Open REWIND once so it can start capturing, or set REWIND_DB.`,
      );
    }
    this.db = new DatabaseSync(path, { readOnly: true });
  }

  /** One work day, whole and oldest first — what the engine expects (CONTEXT_ENGINE). */
  forDay(day: string, limit = 20_000): DaemonEvent[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM events WHERE work_day = ? ORDER BY timestamp ASC LIMIT ?`)
      .all(day, limit) as unknown as Row[];
    return rows.map(toEvent);
  }

  /** The recent stream across days — what a question about last week needs. */
  recent(limit = 20_000): DaemonEvent[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM events ORDER BY timestamp DESC LIMIT ?`)
      .all(limit) as unknown as Row[];
    return rows.map(toEvent);
  }

  /** Every work day with anything in it, newest first. Counted in SQL, never by loading it. */
  days(limit = 400): DaySummary[] {
    const rows = this.db
      .prepare(
        `SELECT work_day AS day, COUNT(*) AS count, MIN(timestamp) AS first,
                MAX(COALESCE(end_timestamp, timestamp)) AS last
         FROM events GROUP BY work_day ORDER BY work_day DESC LIMIT ?`,
      )
      .all(limit) as unknown as DaySummary[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}
