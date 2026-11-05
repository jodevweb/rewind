/**
 * REWIND as an MCP server — your own memory, reachable from the agent you actually work in.
 *
 * The gap this closes: REWIND knows what you were doing on Thursday, and Claude Code does not. So
 * every session begins by explaining the branch, the failing command and the three files, which is
 * the retyping REWIND exists to remove. With this, the agent asks.
 *
 * # Read-only, local, and no port
 *
 * stdio, spoken to by the client that launched it. Nothing listens on a socket, which is the rule
 * that removed the localhost HTTP server (ADR 0001 D-5) and applies here for the same reason. The
 * database is opened read-only: this process cannot write an event, and the daemon stays the only
 * writer of its own store.
 *
 * # Why the protocol is hand-written
 *
 * It is one framing rule — newline-delimited JSON-RPC 2.0 — and four methods. An SDK for that is a
 * dependency tree in a repository whose runtime dependency count is currently zero, on the one
 * process that reads the user's entire history. The whole surface is below, and it is auditable in
 * a sitting.
 *
 * Install (once REWIND has captured something):
 *
 *   claude mcp add rewind -- pnpm --dir <this repo> --filter @rewind/mcp start
 */

import { createInterface } from 'node:readline';

import { Store } from './db.js';
import { askText, dayText, daysText, resumeText, standupText } from './tools.js';

const NAME = 'rewind';
const VERSION = '0.1.0';
/** Echoed back to a client that asks for something else, which is what the specification says to do. */
const FALLBACK_PROTOCOL = '2024-11-05';

interface Request {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const DAY_ARG = {
  day: {
    type: 'string',
    description: 'Work day as YYYY-MM-DD. Omitted means today, or the last day with any work.',
  },
} as const;

const TOOLS = [
  {
    name: 'rewind_resume',
    description:
      'What the user was last working on: the context, its branch and project, the files touched, ' +
      'the commands run, what failed, and the next step REWIND read from the events. Call this at ' +
      'the start of a session instead of asking the user to explain where they left off.',
    inputSchema: { type: 'object', properties: DAY_ARG },
  },
  {
    name: 'rewind_ask',
    description:
      'Ask the user’s own history a question in plain language, in French or English — "where was ' +
      'that stripe doc", "what did I do Thursday afternoon", "which command failed". Answered from ' +
      'stored events, deterministically. When there is not enough evidence it refuses, and a ' +
      'refusal must be reported as such, never completed with a guess.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in the user’s own words.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'rewind_day',
    description:
      'Every piece of work of one day, with its duration, place, files, commands and results. The ' +
      'long form — for a report, a timesheet or a summary of what happened.',
    inputSchema: { type: 'object', properties: DAY_ARG },
  },
  {
    name: 'rewind_standup',
    description: 'The same day as one line per piece of work, ready to paste into a standup.',
    inputSchema: { type: 'object', properties: DAY_ARG },
  },
  {
    name: 'rewind_days',
    description: 'Which work days REWIND holds anything for, newest first, with event counts.',
    inputSchema: { type: 'object', properties: {} },
  },
];

/**
 * The store, opened on first use and kept.
 *
 * Not opened at startup: a client that launches this before REWIND has ever run would see the
 * process exit, and "the MCP server is broken" is a much worse message than "there is nothing
 * recorded yet", which is what the first tool call says.
 */
let store: Store | null = null;
function open(): Store {
  if (!store) store = new Store();
  return store;
}

function closeStore(): void {
  store?.close();
  store = null;
}

function call(name: string, args: Record<string, unknown>): string {
  const now = Date.now();
  const day = typeof args['day'] === 'string' ? (args['day'] as string) : undefined;
  switch (name) {
    case 'rewind_resume':
      return resumeText(open(), day, now);
    case 'rewind_day':
      return dayText(open(), day, now);
    case 'rewind_standup':
      return standupText(open(), day, now);
    case 'rewind_days':
      return daysText(open());
    case 'rewind_ask': {
      const question = typeof args['question'] === 'string' ? (args['question'] as string) : '';
      if (question.trim() === '') throw new Error('rewind_ask needs a question.');
      return askText(open(), question, now);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * One request in, one response out — or `null` for a notification, which takes no reply.
 *
 * Separated from the transport so the whole protocol can be tested by calling a function. A server
 * whose behaviour can only be observed by spawning it and reading its stdout gets tested once.
 */
export function respond(request: Request): unknown | null {
  const { id, method, params = {} } = request;
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown) => (isNotification ? null : { jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion:
          typeof params['protocolVersion'] === 'string'
            ? params['protocolVersion']
            : FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(params['name'] ?? '');
      const args = (params['arguments'] as Record<string, unknown>) ?? {};
      try {
        return reply({ content: [{ type: 'text', text: call(name, args) }] });
      } catch (error) {
        // A tool failure is a result, not a transport error: the model has to be able to read it.
        return reply({
          content: [{ type: 'text', text: `REWIND: ${(error as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return isNotification
        ? null
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/** Newline-delimited JSON-RPC on stdio. That is the whole transport. */
export function serve(): void {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    let request: Request;
    try {
      request = JSON.parse(text) as Request;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const response = respond(request);
      if (response) send(response);
    } catch (error) {
      // Never take the transport down over one bad message: the client cannot restart us.
      if (request.id !== undefined && request.id !== null) {
        send({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32603, message: (error as Error).message },
        });
      }
    }
  });
  lines.on('close', () => {
    closeStore();
    process.exit(0);
  });
}
