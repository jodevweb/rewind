/**
 * Resume payload — deterministic, evidence-only (CONTEXT_ENGINE §11, INITIAL_ANALYSIS PR-2).
 *
 * Every field here is read from stored events. Nothing is generated, nothing is inferred beyond an
 * explicit rule, and every line carries the event it came from so the UI can cite it. An LLM may
 * later add prose *above* this; it may never produce these facts.
 */

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';

import { appName, type EngineContext } from './engine.js';

export interface ResumeLine {
  label: string;
  detail?: string;
  /** Event ref this claim came from. The UI turns it into a citation. */
  evidenceRef: string;
  timestamp: number;
  tone?: 'normal' | 'failure' | 'success';
}

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
  /** Deterministic, from the table below. Omitted entirely when no rule fires. */
  nextStep?: { text: string; evidenceRef: string };
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
          card.openResources.push({
            kind: 'url',
            label: e.title ?? url,
            target: url,
            evidenceRef: e.ref,
          });
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
        break;
      }
      case 'git.status.summary': {
        const dirty = num(e, 'dirtyFiles') ?? 0;
        if (dirty > 0) dirtyFiles = { count: dirty, branch: str(e, 'branch'), ref: e.ref };
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
                : `Claude Code — ${num(e, 'toolCallCount') ?? 0} tool calls`;
        card.produced.push({
          label,
          detail: Array.isArray(files) ? files.map(String).join(', ') : undefined,
          evidenceRef: e.ref,
          timestamp: e.timestamp,
        });
        break;
      }
      case 'ide.workspace.opened': {
        const p = str(e, 'workspacePath');
        if (p)
          card.openResources.push({ kind: 'workspace', label: p, target: p, evidenceRef: e.ref });
        break;
      }
      default:
        break;
    }
  }

  // Terminal cwd, for "open a terminal here" (§62 — shown, never executed).
  const lastCwd = [...events].reverse().find((e) => str(e, 'cwd'));
  if (lastCwd) {
    const cwd = str(lastCwd, 'cwd')!;
    card.openResources.push({
      kind: 'terminal',
      label: cwd,
      target: cwd,
      evidenceRef: lastCwd.ref,
    });
  }

  // Deterministic next step. First rule that fires wins; if none does, the field is omitted rather
  // than filled with a guess.
  if (lastNote) {
    card.nextStep = { text: str(lastNote, 'text') ?? '', evidenceRef: lastNote.ref };
  } else if (lastFailure) {
    card.nextStep = {
      text: `Fix the failing command: ${str(lastFailure, 'commandRedacted')}`,
      evidenceRef: lastFailure.ref,
    };
  } else if (dirtyFiles) {
    card.nextStep = {
      text: `Commit or stash ${dirtyFiles.count} uncommitted file${dirtyFiles.count === 1 ? '' : 's'}${dirtyFiles.branch ? ` on ${dirtyFiles.branch}` : ''}`,
      evidenceRef: dirtyFiles.ref,
    };
  } else if (lastAgent) {
    card.nextStep = { text: `Review the agent's work`, evidenceRef: lastAgent.ref };
  }

  card.working = card.working.slice(-5);
  card.reading = card.reading.slice(-5);
  card.ran = card.ran.slice(-3);
  card.produced = card.produced.slice(-4);
  card.failures = card.failures.slice(-1);
  return card;
}
