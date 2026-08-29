/**
 * Resume payload — deterministic, evidence-only (CONTEXT_ENGINE §11, INITIAL_ANALYSIS PR-2).
 *
 * Every field here is read from stored events. Nothing is generated, nothing is inferred beyond an
 * explicit rule, and every line carries the event it came from so the UI can cite it. An LLM may
 * later add prose *above* this; it may never produce these facts.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

import { appName, type EngineContext } from './engine.js';

/**
 * How many things "resume" is allowed to reopen at once.
 *
 * A cap, not a preference: a context that touched sixty files must not turn one click into sixty
 * windows. Ten is about what a person can look at after a weekend away.
 */
export const RESUME_OPEN_LIMIT = 10;

export interface ResumeLine {
  label: string;
  detail?: string;
  /** Event ref this claim came from. The UI turns it into a citation. */
  evidenceRef: string;
  timestamp: number;
  tone?: 'normal' | 'failure' | 'success';
}

export type NextStep =
  | { rule: 'quote_note'; text: string; evidenceRef: string }
  | { rule: 'fix_failing_command'; command: string; evidenceRef: string }
  | { rule: 'commit_or_stash'; count: number; branch?: string; evidenceRef: string }
  | { rule: 'review_agent_work'; evidenceRef: string };

export interface ResumeCard {
  contextLabel: string;
  lastActiveAt: number;
  activeMs: number;
  appChain: string[];
  working: ResumeLine[];
  reading: ResumeLine[];
  ran: ResumeLine[];
  produced: ResumeLine[];
  failures: ResumeLine[];
  notes: ResumeLine[];
  /**
   * Deterministic, from the table below. Omitted entirely when no rule fires.
   *
   * Structured rather than a sentence: the engine must not emit user-facing prose, because prose
   * cannot be translated at the point of display. It states which rule fired and with what values;
   * the UI renders it in the reader's language (§147).
   */
  nextStep?: NextStep;
  openResources: { kind: string; label: string; target: string; evidenceRef: string }[];
}

const str = (e: GoldenEvent, k: string): string | undefined => {
  const v = (e.metadata as Record<string, unknown>)[k];
  return typeof v === 'string' ? v : undefined;
};
const num = (e: GoldenEvent, k: string): number | undefined => {
  const v = (e.metadata as Record<string, unknown>)[k];
  return typeof v === 'number' ? v : undefined;
};

export function buildResume(session: GoldenSession, context: EngineContext): ResumeCard {
  const byRef = new Map(session.events.map((e) => [e.ref, e]));
  const events = context.eventRefs
    .map((r) => byRef.get(r))
    .filter((e): e is GoldenEvent => Boolean(e))
    .sort((a, b) => a.timestamp - b.timestamp);

  const card: ResumeCard = {
    contextLabel: context.label,
    lastActiveAt: context.endTimestamp,
    activeMs: context.activeMs,
    appChain: context.appChain,
    working: [],
    reading: [],
    ran: [],
    produced: [],
    failures: [],
    notes: [],
    openResources: [],
  };

  const seen = new Set<string>();
  const once = (bucket: ResumeLine[], key: string, line: ResumeLine) => {
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push(line);
  };

  /**
   * Everything this context can be reopened from, deduplicated by target.
   *
   * This used to be filled by three event types the real collectors do not produce yet — a browser
   * navigation, an IDE workspace and a terminal `cwd` — so on a real day it was empty and "resume"
   * meant reading a card rather than getting back to work. It now reads the sources that exist:
   * an agent session knows its project path and the files it touched, and a saved file is a file.
   */
  const resources = new Set<string>();
  const resource = (kind: string, label: string, target: unknown, evidenceRef: string) => {
    if (typeof target !== 'string') return;
    const trimmed = target.trim();
    if (trimmed === '' || resources.has(trimmed)) return;
    resources.add(trimmed);
    card.openResources.push({ kind, label, target: trimmed, evidenceRef });
  };

  /** A file a tool reported relative to its project is only openable once it is absolute again. */
  const absolute = (file: string, base: string | undefined): string =>
    file.startsWith('/') || /^[A-Za-z]:/.test(file) || !base ? file : `${base}/${file}`;

  let lastFailure: GoldenEvent | undefined;
  let dirtyFiles: { count: number; branch?: string; ref: string } | undefined;
  let lastNote: GoldenEvent | undefined;
  let lastAgent: GoldenEvent | undefined;

  for (const e of events) {
    switch (e.type) {
      case 'ide.file.saved':
      case 'ide.file.opened':
      case 'fs.file.created':
      case 'fs.file.renamed': {
        const p = str(e, 'path') ?? str(e, 'toPath');
        if (p) {
          const leaf = p.split(/[/\\]/).pop()!;
          once(card.working, `file:${leaf}`, {
            label: leaf,
            detail: p,
            evidenceRef: e.ref,
            timestamp: e.timestamp,
          });
          resource('file', leaf, p, e.ref);
        }
        break;
      }
      case 'browser.navigation': {
        const url = str(e, 'url');
        if (url) {
          once(card.reading, `url:${url}`, {
            label: e.title ?? str(e, 'host') ?? url,
            detail: url,
            evidenceRef: e.ref,
            timestamp: e.timestamp,
          });
          resource('url', e.title ?? url, url, e.ref);
        }
        break;
      }
      case 'terminal.command': {
        const cmd = str(e, 'commandRedacted');
        const exit = num(e, 'exitCode');
        if (cmd) {
          card.ran.push({
            label: cmd,
            detail: exit === 0 ? 'exit 0' : `exit ${exit ?? '?'}`,
            evidenceRef: e.ref,
            timestamp: e.timestamp,
            tone: exit === 0 ? 'success' : 'failure',
          });
          if (exit !== 0) lastFailure = e;
        }
        break;
      }
      case 'terminal.error_tail': {
        const lines = (e.metadata as Record<string, unknown>)['lines'];
        if (Array.isArray(lines) && lines.length > 0) {
          card.failures.push({
            label: String(lines[0]),
            detail: lines.slice(1).map(String).join('\n'),
            evidenceRef: e.ref,
            timestamp: e.timestamp,
            tone: 'failure',
          });
        }
        break;
      }
      case 'git.commit': {
        const sha = str(e, 'sha');
        card.produced.push({
          label: str(e, 'messageRedacted') ?? 'commit',
          detail: sha ? sha.slice(0, 7) : undefined,
          evidenceRef: e.ref,
          timestamp: e.timestamp,
          tone: 'success',
        });
        resource('folder', str(e, 'repository') ?? 'repo', str(e, 'worktree'), e.ref);
        break;
      }
      case 'git.branch.checkout':
      case 'git.repo.detected':
        resource(
          'folder',
          str(e, 'repository') ?? 'repo',
          str(e, 'worktree') ?? str(e, 'path'),
          e.ref,
        );
        break;
      case 'git.status.summary': {
        const dirty = num(e, 'dirtyFiles') ?? 0;
        if (dirty > 0) dirtyFiles = { count: dirty, branch: str(e, 'branch'), ref: e.ref };
        resource('folder', str(e, 'repository') ?? 'repo', str(e, 'worktree'), e.ref);
        break;
      }
      case 'manual.note': {
        lastNote = e;
        card.notes.push({
          label: str(e, 'text') ?? '',
          evidenceRef: e.ref,
          timestamp: e.timestamp,
        });
        break;
      }
      case 'external.run.finished':
      case 'external.mission.started':
      case 'agent.session.started':
      // The type the real collector actually writes. It was missing here while the three synthetic
      // ones were handled, so a day spent in Claude Code produced a Resume card with nothing in it.
      case 'agent.session':
      case 'agent.activity': {
        lastAgent = e;
        const files = (e.metadata as Record<string, unknown>)['filesTouched'];
        const label =
          e.type === 'external.mission.started'
            ? `Cockpit mission: ${str(e, 'mission') ?? ''}`
            : e.type === 'external.run.finished'
              ? `Cockpit run ${str(e, 'runId') ?? ''} — ${str(e, 'status') ?? ''}`
              : e.type === 'agent.session.started'
                ? `Claude Code session started`
                : e.type === 'agent.session'
                  ? (str(e, 'title') ?? e.title ?? 'Claude Code')
                  : `Claude Code — ${num(e, 'toolCallCount') ?? 0} tool calls`;
        card.produced.push({
          label,
          detail: Array.isArray(files) ? files.map(String).join(', ') : undefined,
          evidenceRef: e.ref,
          timestamp: e.timestamp,
        });

        // An agent session is, in practice, the richest thing to reopen: it knows the project it ran
        // in and every file it touched. Without this the Resume card of a day spent in Claude Code
        // had nothing to open at all.
        const project = str(e, 'projectPath') ?? str(e, 'worktree') ?? str(e, 'cwd');
        if (project)
          resource(
            'workspace',
            project.split(/[/\\]/).filter(Boolean).pop() ?? project,
            project,
            e.ref,
          );
        if (Array.isArray(files)) {
          for (const f of files.slice(0, 8)) {
            if (typeof f !== 'string' || f.trim() === '') continue;
            resource('file', f.split(/[/\\]/).pop() ?? f, absolute(f, project), e.ref);
          }
        }
        break;
      }
      case 'ide.workspace.opened': {
        resource('workspace', str(e, 'workspacePath') ?? '', str(e, 'workspacePath'), e.ref);
        break;
      }
      default:
        break;
    }
  }

  // Terminal cwd, for "open a terminal here" (§62 — shown, never executed).
  const lastCwd = [...events].reverse().find((e) => str(e, 'cwd'));
  if (lastCwd) resource('terminal', str(lastCwd, 'cwd')!, str(lastCwd, 'cwd'), lastCwd.ref);

  // Deterministic next step. First rule that fires wins; if none does, the field is omitted rather
  // than filled with a guess.
  if (lastNote) {
    // The user's own words, quoted verbatim — never paraphrased, and never translated.
    card.nextStep = {
      rule: 'quote_note',
      text: str(lastNote, 'text') ?? '',
      evidenceRef: lastNote.ref,
    };
  } else if (lastFailure) {
    card.nextStep = {
      rule: 'fix_failing_command',
      command: str(lastFailure, 'commandRedacted') ?? '',
      evidenceRef: lastFailure.ref,
    };
  } else if (dirtyFiles) {
    card.nextStep = {
      rule: 'commit_or_stash',
      count: dirtyFiles.count,
      ...(dirtyFiles.branch ? { branch: dirtyFiles.branch } : {}),
      evidenceRef: dirtyFiles.ref,
    };
  } else if (lastAgent) {
    card.nextStep = { rule: 'review_agent_work', evidenceRef: lastAgent.ref };
  }

  card.working = card.working.slice(-5);
  card.reading = card.reading.slice(-5);
  card.ran = card.ran.slice(-3);
  card.produced = card.produced.slice(-4);
  card.failures = card.failures.slice(-1);

  // Ordered for reopening, not for reading: the place first, then what was open in it. Opening a
  // file before its workspace lands it in whatever editor claimed the extension, which is how
  // "resume" turns into ten seconds of closing windows.
  const rank: Record<string, number> = { workspace: 0, folder: 1, terminal: 2, file: 3, url: 4 };
  card.openResources.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
  card.openResources = card.openResources.slice(0, RESUME_OPEN_LIMIT);
  return card;
}
