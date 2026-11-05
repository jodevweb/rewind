/**
 * The home screen's model: your work as projects, not as a day of events.
 *
 * The engine answers "what was this day made of". The person opening the window asks something
 * else — "where was I, and what did I leave lying around" — and thinks of the answer in projects:
 * the app, the client site, the side project paused last week. A project is the one unit that survives across days,
 * and every source already names it: a Claude Code session carries its project directory, Git its
 * worktree, a shell command its working directory. This module only joins those up.
 *
 * Pure, like the rest of the interface's reasoning: events and a clock in, plain data out. The
 * wording lives in the component, so this file holds no sentence and no language.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { workDay } from '@rewind/predict';

const DAY_MS = 86_400_000;

/** Untouched for longer than this, a project is paused rather than in progress. */
export const PAUSED_AFTER_DAYS = 7;

/** How many projects the home screen holds: one large tile and five small ones. */
export const HOME_PROJECTS = 6;

/** A run of work on one project, in milliseconds. */
export interface Span {
  start: number;
  end: number;
}

export interface Project {
  /** Normalised path: one spelling per directory, whatever tool reported it. */
  key: string;
  name: string;
  path: string;
  lastAt: number;
  branch?: string;
  /** Files Git reports as uncommitted, from the latest status seen. `undefined` when never seen. */
  dirty?: number;
  lastCommit?: { message: string; at: number };
  /** The title of the latest agent session (Claude Code, Codex…) that has a real one. */
  lastSession?: { title: string; at: number };
  /** Files the recent sessions touched, absolute, newest first: what "Reprendre" reopens. */
  files: string[];
  /** Today's work on it, for the band. */
  today: Span[];
  /** Distinct work days with activity, over the last seven. */
  daysThisWeek: number;
  sessions: number;
}

export type WeekNote =
  | { kind: 'main'; name: string; days: number }
  | { kind: 'paused'; name: string; days: number }
  | { kind: 'recoveries'; count: number };

export interface HomeModel {
  /** Newest first. The first one is the large tile. */
  projects: Project[];
  /** The band's time axis for today, so every tile draws against the same hours. */
  axis: Span | null;
  week: WeekNote[];
  now: number;
  tz: number;
}

const str = (e: GoldenEvent, k: string): string | undefined => {
  const v = e.metadata[k];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
};
const num = (e: GoldenEvent, k: string): number | undefined => {
  const v = e.metadata[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

const isWindowsPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\');

/** One spelling per directory. Windows paths are case-insensitive and arrive with either slash. */
export function pathKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  return isWindowsPath(trimmed) ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

const sep = (key: string) => (key.includes('\\') ? '\\' : '/');
const contains = (root: string, key: string) => key === root || key.startsWith(root + sep(root));
const leaf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Agents make throwaway repositories in the temporary directory by the dozen. They are not work
 * anybody comes back to, and as projects they would bury the real ones.
 */
export function isScratch(path: string): boolean {
  return /[\\/](temp|tmp)[\\/]/i.test(path) || /[\\/]scratchpad([\\/]|$)/i.test(path);
}

/** "Claude Code — Atlas" or "Codex — Atlas" is the default title: it says where, never what. */
const isGenericTitle = (title: string) => /^(claude code|codex)\b/i.test(title.trim());

function absolute(file: string, base: string): string {
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/')) return file;
  const s = isWindowsPath(base) ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${s}${file}`;
}

/** Where an event says it happened, as a directory. */
function placeOf(e: GoldenEvent): string | undefined {
  return str(e, 'projectPath') ?? str(e, 'worktree') ?? str(e, 'workspacePath') ?? str(e, 'cwd');
}

/** Only these sources say which project; the rest is context the engine reads, not a project. */
const NAMES_A_PROJECT = new Set([
  'agent.session',
  'git.commit',
  'git.status.summary',
  'git.branch.checkout',
]);

export function buildHome(history: GoldenSession, now: number): HomeModel {
  const tz = history.tzOffsetMinutes;
  const today = workDay(now, tz);
  const weekDays = new Set(Array.from({ length: 7 }, (_, i) => workDay(now - i * DAY_MS, tz)));

  // 1. Which directories are projects. Only a session or a repository makes one — a shell cd'd
  //    into the home directory does not. A directory that holds other projects is a workspace
  //    folder (`D:\work`, the home directory), not a project: its children are.
  const roots = new Map<string, string>();
  for (const e of history.events) {
    if (!NAMES_A_PROJECT.has(e.type)) continue;
    const place = placeOf(e);
    if (!place || isScratch(place)) continue;
    const key = pathKey(place);
    if (!roots.has(key)) roots.set(key, place.replace(/[\\/]+$/, ''));
  }
  const keys = [...roots.keys()];
  const projectKeys = keys.filter((k) => !keys.some((other) => other !== k && contains(k, other)));
  // Deepest first, so a command run in `repo/src` lands on `repo` and not on a parent.
  const byDepth = [...projectKeys].sort((a, b) => b.length - a.length);
  const owner = (place: string | undefined) => {
    if (!place || isScratch(place)) return undefined;
    const key = pathKey(place);
    return byDepth.find((root) => contains(root, key));
  };

  // 2. Everything each project did.
  const projects = new Map<string, Project & { days: Set<string> }>();
  for (const key of projectKeys) {
    const path = roots.get(key)!;
    projects.set(key, {
      key,
      path,
      name: leaf(path),
      lastAt: 0,
      files: [],
      today: [],
      daysThisWeek: 0,
      sessions: 0,
      days: new Set(),
    });
  }

  const ordered = [...history.events].sort((a, b) => a.timestamp - b.timestamp);
  for (const e of ordered) {
    const key = owner(placeOf(e));
    if (!key) continue;
    const p = projects.get(key)!;
    const end = Math.max(e.endTimestamp ?? e.timestamp, e.timestamp);
    p.lastAt = Math.max(p.lastAt, end);
    const day = workDay(e.timestamp, e.tzOffsetMinutes ?? tz);
    if (weekDays.has(day)) p.days.add(day);

    let span: Span | null = null;
    switch (e.type) {
      case 'agent.session': {
        p.sessions += 1;
        const title = e.title?.trim() || str(e, 'title');
        if (title && !isGenericTitle(title)) p.lastSession = { title, at: end };
        const branch = str(e, 'gitBranch');
        if (branch && branch !== 'HEAD') p.branch = branch;
        const touched = e.metadata['filesTouched'];
        if (Array.isArray(touched)) {
          const fresh = touched
            .filter((f): f is string => typeof f === 'string' && !isScratch(f))
            .map((f) => absolute(f, p.path));
          p.files = [...new Set([...fresh.reverse(), ...p.files])].slice(0, 8);
        }
        span = { start: e.timestamp, end };
        break;
      }
      case 'git.commit': {
        const message = str(e, 'messageRedacted') ?? e.title;
        if (message) p.lastCommit = { message, at: e.timestamp };
        const branch = str(e, 'branch');
        if (branch) p.branch = branch;
        span = { start: e.timestamp, end: e.timestamp + 60_000 };
        break;
      }
      case 'git.status.summary': {
        const dirty = num(e, 'dirtyFiles');
        if (dirty !== undefined) p.dirty = dirty;
        break;
      }
      case 'git.branch.checkout': {
        const branch = str(e, 'to') ?? str(e, 'branch');
        if (branch) p.branch = branch;
        break;
      }
      case 'terminal.command': {
        const duration = num(e, 'durationMs') ?? 0;
        span = { start: e.timestamp, end: e.timestamp + Math.max(duration, 60_000) };
        break;
      }
    }
    if (span && day === today) p.today.push(span);
  }

  const all = [...projects.values()]
    .filter((p) => p.lastAt > 0)
    .map(({ days, ...p }) => ({ ...p, today: merge(p.today), daysThisWeek: days.size }))
    .sort((a, b) => b.lastAt - a.lastAt);

  const shown = all.slice(0, HOME_PROJECTS);

  // 3. The band's axis: from the first hour anything happened today to now, whole hours.
  const todaySpans = shown.flatMap((p) => p.today);
  let axis: Span | null = null;
  if (todaySpans.length > 0) {
    const hour = 3_600_000;
    const offset = tz * 60_000;
    const first = Math.min(...todaySpans.map((s) => s.start));
    const last = Math.max(now, ...todaySpans.map((s) => s.end));
    const start = Math.floor((first + offset) / hour) * hour - offset;
    const end = Math.max(Math.ceil((last + offset) / hour) * hour - offset, start + 4 * hour);
    axis = { start, end };
  }

  return { projects: shown, axis, week: weekNotes(all, history, now, weekDays), now, tz };
}

/** Overlapping or touching runs become one, so the band draws blocks rather than a comb. */
function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 10 * 60_000) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/**
 * What the week says, in at most three observations — and none when there is too little to say.
 * Each one is a count of stored events, never a judgement: no score, no "productive".
 */
function weekNotes(
  all: Project[],
  history: GoldenSession,
  now: number,
  weekDays: Set<string>,
): WeekNote[] {
  const notes: WeekNote[] = [];

  const main = [...all].sort((a, b) => b.daysThisWeek - a.daysThisWeek)[0];
  if (main && main.daysThisWeek >= 3) {
    notes.push({ kind: 'main', name: main.name, days: main.daysThisWeek });
  }

  // The project most worked on that has gone quiet — the one most likely to be forgotten.
  const paused = all
    .map((p) => ({ p, idle: Math.floor((now - p.lastAt) / DAY_MS) }))
    .filter(({ idle }) => idle >= PAUSED_AFTER_DAYS && idle <= 30)
    .sort((a, b) => b.p.sessions - a.p.sessions)[0];
  if (paused && paused.p.sessions >= 5) {
    notes.push({ kind: 'paused', name: paused.p.name, days: paused.idle });
  }

  // Sessions whose whole purpose was getting back to where a crash left you: exactly the moment
  // this application exists for, and a cost nobody counts.
  const recoveries = history.events.filter(
    (e) =>
      e.type === 'agent.session' &&
      weekDays.has(workDay(e.timestamp, e.tzOffsetMinutes ?? history.tzOffsetMinutes)) &&
      /plantage|crash/i.test(e.title ?? ''),
  ).length;
  if (recoveries >= 3) notes.push({ kind: 'recoveries', count: recoveries });

  return notes;
}

/** A span as left offset and width, in percent of the axis. */
export function place(span: Span, axis: Span): { left: number; width: number } {
  const total = axis.end - axis.start;
  const left = Math.max(0, Math.min(100, ((span.start - axis.start) / total) * 100));
  const right = Math.max(0, Math.min(100, ((span.end - axis.start) / total) * 100));
  return { left, width: Math.max(1.5, right - left) };
}

/** Everything a fresh agent needs to pick a project back up, as plain text. */
export function projectBrief(p: Project): string {
  const lines = [`Je reprends le projet ${p.name} (${p.path}).`];
  if (p.branch) lines.push(`Branche : ${p.branch}`);
  if (p.lastSession) lines.push(`Dernière session : ${p.lastSession.title}`);
  if (p.lastCommit) lines.push(`Dernier commit : ${p.lastCommit.message}`);
  if (p.dirty) lines.push(`Fichiers non commités : ${p.dirty}`);
  if (p.files.length > 0) {
    lines.push('Fichiers touchés récemment :');
    for (const f of p.files) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}
