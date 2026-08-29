/**
 * The MCP server, against a real database.
 *
 * Written against SQLite rather than a stubbed store on purpose: the two things most likely to break
 * this are the column names and the read-only flag, and neither is visible to a test that mocks the
 * store away. The schema below is copied from `store.rs`, and a test that fails because the daemon's
 * schema moved is exactly the failure worth having.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DatabaseSync, Store } from './db.js';
import { respond } from './server.js';
import {
  askText,
  dayText,
  daysText,
  NOTHING,
  resumeText,
  resumeTextForProject,
  standupText,
} from './tools.js';

const SCHEMA = `
  CREATE TABLE events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp         INTEGER NOT NULL,
    end_timestamp     INTEGER,
    tz_offset_minutes INTEGER NOT NULL,
    work_day          TEXT    NOT NULL,
    source            TEXT    NOT NULL,
    type              TEXT    NOT NULL,
    app_id            TEXT    NOT NULL,
    app_display       TEXT    NOT NULL,
    title             TEXT,
    pid               INTEGER,
    redaction_version TEXT    NOT NULL,
    redaction_applied TEXT    NOT NULL,
    redaction_count   INTEGER NOT NULL,
    importance        INTEGER NOT NULL,
    metadata          TEXT    NOT NULL DEFAULT '{}'
  );
`;

const DAY = '2026-08-27';
const AT = Date.UTC(2026, 7, 27, 13, 0);
const TZ = 60;

let dir: string;
let path: string;
let store: Store;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rewind-mcp-'));
  path = join(dir, 'rewind.db');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const insert = db.prepare(
    `INSERT INTO events (timestamp, end_timestamp, tz_offset_minutes, work_day, source, type,
       app_id, app_display, title, pid, redaction_version, redaction_applied, redaction_count,
       importance, metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );

  const agent = JSON.stringify({
    projectPath: '/Users/dev/dev/acme-web',
    gitBranch: 'feat/ACME-412-pagination',
    repository: 'acme-web',
    toolCallCount: 20,
    filesTouched: ['src/table.tsx'],
  });
  const failing = JSON.stringify({
    commandRedacted: 'pnpm check',
    exitCode: 1,
    cwd: '/Users/dev/dev/acme-web',
    branch: 'feat/ACME-412-pagination',
    repository: 'acme-web',
  });

  insert.run(
    AT,
    AT + 1800000,
    TZ,
    DAY,
    'agent',
    'agent.session',
    'claude-code',
    'Claude Code',
    'Pagination du tableau (ACME-412)',
    null,
    '1',
    '',
    0,
    70,
    agent,
  );
  insert.run(
    AT + 2400000,
    null,
    TZ,
    DAY,
    'terminal',
    'terminal.command',
    'zsh',
    'Terminal',
    'pnpm check',
    null,
    '1',
    '',
    0,
    75,
    failing,
  );
  db.close();

  store = new Store(path);
});

afterAll(() => {
  store.close();
  // Best effort: Windows refuses to remove a directory while any handle into it is still open, and
  // a failed cleanup of a temp directory is not a reason to fail a suite that passed.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the operating system will collect it */
  }
});

describe('reading the daemon’s store from outside it', () => {
  it('reads a day back through the same adapter the window uses', () => {
    const events = store.forDay(DAY);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('agent.session');
    expect(events[0]!.metadata).toContain('feat/ACME-412-pagination');
  });

  it('refuses to write, whatever is asked of it', () => {
    // The daemon is the only writer of its own store, and this process must not be able to insert
    // an event — one without a redaction stamp could not be a legitimate event anyway.
    const readOnly = new DatabaseSync(path, { readOnly: true });
    try {
      expect(() => readOnly.exec('DELETE FROM events')).toThrow();
    } finally {
      readOnly.close();
    }
  });

  it('says where it looked when there is no store there', () => {
    expect(() => new Store(join(dir, 'nope.db'))).toThrow(/no store at/);
  });
});

describe('what an agent gets back', () => {
  it('resume carries the branch, the failing command and its provenance', () => {
    const text = resumeText(store, DAY, AT + 3600000);
    expect(text).toContain('feat/ACME-412-pagination');
    expect(text).toContain('pnpm check');
    expect(text).toContain('REWIND');
  });

  it('answers for the project a session starts in, and only that one', () => {
    // What the SessionStart hook hands a new agent. Two agents side by side in two repositories
    // is an ordinary day here, and a card confidently describing the other one is worse than no
    // card: the reader has no way to tell it is about somewhere else.
    const here = resumeTextForProject(store, AT, '/Users/dev/dev/acme-web');
    expect(here).toContain('acme-web');
    expect(here).not.toBe(NOTHING);

    expect(resumeTextForProject(store, AT, '/Users/dev/dev/somewhere-else')).toBe(NOTHING);
  });

  it('does not care which separator or case the directory arrives in', () => {
    // The hook is handed a path by the host: Windows backslashes here, POSIX on the MacBook, and
    // the drive letter is capitalised by some callers and not others.
    const posix = resumeTextForProject(store, AT, '/Users/dev/dev/acme-web');
    expect(resumeTextForProject(store, AT, '/Users/dev/dev/acme-web/')).toBe(posix);
    expect(resumeTextForProject(store, AT, '/Users/Dev/Dev/ACME-Web')).toBe(posix);
  });
  it('a day reads as a worklog and as a standup, from the same events', () => {
    expect(dayText(store, DAY, AT)).toContain('ACME-412');
    expect(
      standupText(store, DAY, AT)
        .split('\n')
        .some((l) => l.startsWith('- ')),
    ).toBe(true);
  });

  it('lists the days it holds', () => {
    expect(daysText(store)).toContain(DAY);
  });

  it('passes a refusal through as a refusal', () => {
    // Nothing here mentions Kubernetes. The answer must be that there is no answer — an agent handed
    // a near miss dressed as a hit will act on it.
    const text = askText(store, 'où était la documentation kubernetes ?', AT + 3600000);
    expect(text).toMatch(/refuse/);
    expect(text).toContain('Ne complète pas cette réponse par une supposition.');
  });

  it('answers a question it does have the evidence for', () => {
    const text = askText(store, 'quelle commande a échoué ?', AT + 3600000);
    expect(text).toContain('pnpm check');
  });
});

describe('the protocol', () => {
  it('echoes the protocol version the client asked for', () => {
    const result = respond({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    }) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(result.result.protocolVersion).toBe('2025-06-18');
    expect(result.result.serverInfo.name).toBe('rewind');
  });

  it('answers a notification with nothing at all', () => {
    // A reply to a notification is a protocol error, not a harmless extra.
    expect(respond({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('lists its tools with a schema each', () => {
    const listed = respond({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as {
      result: { tools: { name: string; inputSchema: unknown }[] };
    };
    expect(listed.result.tools.map((t) => t.name)).toContain('rewind_resume');
    for (const tool of listed.result.tools) expect(tool.inputSchema).toBeTruthy();
  });

  it('turns a bad call into a readable result rather than a dead transport', () => {
    const bad = respond({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'rewind_nonexistent', arguments: {} },
    }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toContain('Unknown tool');
  });

  it('reports an unknown method as an error with an id', () => {
    const unknown = respond({ jsonrpc: '2.0', id: 4, method: 'resources/list' }) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
  });
});
