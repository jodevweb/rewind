/**
 * The product's interface: Today, Resume, Timeline. Shared by the desktop application and the studio.
 *
 * Rewritten for volume. The first version was designed against fixtures of forty events; with a real
 * day of capture it needed scrolling for everything, buried new activity at the bottom, and listed a
 * minute-by-minute tree that no one can read.
 *
 * The rules that came out of that:
 *
 *   - **Newest first.** New activity appears where you are already looking, never below the fold.
 *   - **Each column scrolls on its own, under a heading that stays put.** The page itself never
 *     scrolls, so nothing is ever lost off the top.
 *   - **Repetition collapses.** Returning to the same window eleven times is one line saying eleven,
 *     not eleven lines.
 *   - **Today means today.** A context nobody has touched for hours is history, and history belongs
 *     under its own heading.
 *   - **Anything shown can be opened.** Seeing that you edited a file matters far less than being
 *     able to open it.
 */

import { useMemo, useState, type ReactNode } from 'react';

import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import {
  buildResume,
  runEngine,
  strength,
  type Activity,
  type EngineContext,
  type NextStep,
} from '@rewind/engine-v0';

import { predict, type Predictions } from '@rewind/predict';

import { Forecast } from './forecast.js';
import { formatDuration, t, tPlural } from './i18n.js';

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);
const hourKey = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 13);

/** A context untouched for longer than this is history, not today. */
const RECENT_MS = 3 * 60 * 60 * 1000;

export const SOURCES: Record<string, { glyph: string; label: string }> = {
  system: { glyph: '▢', label: 'Système' },
  browser: { glyph: '◍', label: 'Navigateur' },
  ide: { glyph: '◆', label: 'Éditeur' },
  filesystem: { glyph: '▤', label: 'Fichiers' },
  git: { glyph: '◈', label: 'Git' },
  terminal: { glyph: '▸', label: 'Terminal' },
  agent: { glyph: '✳', label: 'Agent' },
  external: { glyph: '⬢', label: 'Cockpit' },
  manual: { glyph: '✎', label: 'Note' },
};

const meta = (e: GoldenEvent) => e.metadata as Record<string, unknown>;
const str = (e: GoldenEvent, k: string) =>
  typeof meta(e)[k] === 'string' ? (meta(e)[k] as string) : undefined;
const leaf = (p: string | undefined) => (p ?? '').split(/[/\\]/).filter(Boolean).pop() ?? '';

export function headline(e: GoldenEvent): string {
  const m = meta(e);
  switch (e.type) {
    case 'terminal.command':
      return str(e, 'commandRedacted') ?? 'commande';
    case 'terminal.error_tail':
      return Array.isArray(m['lines']) ? String((m['lines'] as unknown[])[0]) : 'erreur';
    case 'git.commit':
      return str(e, 'messageRedacted') ?? 'commit';
    case 'git.branch.checkout':
      return `checkout ${str(e, 'to') ?? ''}`;
    case 'git.status.summary':
      return `${m['dirtyFiles'] ?? 0} fichier(s) non commités · ${str(e, 'branch') ?? ''}`;
    case 'git.repo.detected':
      return `dépôt détecté · ${leaf(str(e, 'path'))}`;
    case 'git.stash':
      return `stash · ${str(e, 'target') ?? ''}`;
    case 'manual.note':
      return str(e, 'text') ?? '';
    case 'ide.file.saved':
    case 'ide.file.opened':
      return leaf(str(e, 'path'));
    case 'ide.workspace.opened':
      return leaf(str(e, 'workspacePath'));
    case 'ide.diagnostic.error':
      return str(e, 'messageRedacted') ?? 'erreur';
    case 'fs.batch':
      return `${m['count'] ?? 0} modifications de fichiers`;
    case 'fs.file.created':
    case 'fs.file.modified':
      return leaf(str(e, 'path'));
    case 'fs.file.renamed':
      return `${leaf(str(e, 'fromPath'))} → ${leaf(str(e, 'toPath'))}`;
    case 'agent.session':
    case 'agent.session.started':
      return (str(e, 'title') ?? e.title) || 'session Claude Code';
    case 'agent.activity':
      return `Claude Code — ${m['toolCallCount'] ?? 0} appels d’outils`;
    case 'external.mission.started':
      return `mission : ${str(e, 'mission') ?? ''}`;
    case 'external.run.finished':
      return `run ${str(e, 'runId') ?? ''} — ${str(e, 'status') ?? ''}`;
    case 'external.agent.started':
      return `agent ${str(e, 'agent') ?? ''} démarré`;
    default:
      // `||` rather than `??`: an empty title is not a title, and without Accessibility every title
      // is empty — a row with a timestamp and nothing else reads as a bug, not a degraded mode.
      return e.title || e.appDisplay || e.app || e.type;
  }
}

const isFailure = (e: GoldenEvent) =>
  (e.type === 'terminal.command' && meta(e)['exitCode'] !== 0) ||
  e.type === 'terminal.error_tail' ||
  e.type === 'ide.diagnostic.error';

const isWin = (e: GoldenEvent) =>
  e.type === 'git.commit' ||
  (e.type === 'terminal.command' && meta(e)['exitCode'] === 0) ||
  (e.type === 'external.run.finished' && str(e, 'status') === 'succeeded');

/** Everything openable an event points at. This is what turns a record into something actionable. */
export function targetsOf(e: GoldenEvent): { label: string; target: string; kind: string }[] {
  const m = meta(e);
  const out: { label: string; target: string; kind: string }[] = [];
  const push = (label: string, target: unknown, kind: string) => {
    if (typeof target === 'string' && target.trim() !== '') out.push({ label, target, kind });
  };

  push('url', m['url'], 'url');
  push('fichier', m['path'] ?? m['toPath'], 'file');
  push('dossier', m['directory'] ?? m['cwd'] ?? m['projectPath'] ?? m['workspacePath'], 'folder');
  push('worktree', m['worktree'], 'folder');

  const files = m['filesTouched'];
  if (Array.isArray(files)) {
    const base = typeof m['projectPath'] === 'string' ? (m['projectPath'] as string) : '';
    for (const f of files.slice(0, 12)) {
      if (typeof f !== 'string') continue;
      const abs = f.startsWith('/') || /^[A-Za-z]:/.test(f) ? f : base ? `${base}/${f}` : f;
      out.push({ label: leaf(f), target: abs, kind: 'file' });
    }
  }
  return out;
}

export interface WorkspaceActions {
  open?: (target: string) => void;
  reveal?: (target: string) => void;
}

export function Workspace({
  session,
  aside,
  emptyMessage,
  actions,
  now,
}: {
  session: GoldenSession;
  aside?: ReactNode;
  emptyMessage?: ReactNode;
  actions?: WorkspaceActions;
  /**
   * Wall clock, injected rather than read. Predictions depend on the hour, so passing it keeps the
   * whole view a pure function of its inputs — which is what makes it testable and reproducible.
   */
  now?: number;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  const result = useMemo(() => runEngine(session), [session]);
  const predictions: Predictions = useMemo(
    () => predict(session, now ?? Date.now()),
    [session, now],
  );
  const byRef = useMemo(() => new Map(session.events.map((e) => [e.ref, e])), [session]);
  const tz = session.tzOffsetMinutes;

  // "Recent" is measured against the newest event, not the wall clock, so a replayed fixture and a
  // live capture behave the same way.
  const latest = useMemo(
    () => session.events.reduce((max, e) => Math.max(max, e.endTimestamp ?? e.timestamp), 0),
    [session],
  );
  const [recent, earlier] = useMemo(() => {
    const r: EngineContext[] = [];
    const e: EngineContext[] = [];
    for (const c of result.contexts) {
      (latest - c.endTimestamp <= RECENT_MS ? r : e).push(c);
    }
    return [r, e];
  }, [result.contexts, latest]);

  const active = result.contexts.find((c) => c.id === selected) ?? recent[0] ?? result.contexts[0];
  const resume = useMemo(() => (active ? buildResume(session, active) : null), [session, active]);
  const inspectedEvent = inspected ? (byRef.get(inspected) ?? null) : null;

  if (session.events.length === 0 && emptyMessage) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <main>
      <section className="col">
        <h2 className="col-head">{t('today.title')}</h2>
        <div className="col-body">
          <p className="hint">{t('today.hint')}</p>
          {recent.map((c, i) => (
            <ContextCard
              key={c.id}
              context={c}
              hue={i}
              isActive={active?.id === c.id}
              onSelect={() => setSelected(c.id)}
            />
          ))}
          {recent.length === 0 && <p className="noise">{t('today.none')}</p>}

          {earlier.length > 0 && (
            <>
              <button className="disclosure" onClick={() => setShowEarlier((v) => !v)}>
                {showEarlier ? '▾' : '▸'} {t('today.earlier')} · {earlier.length}
              </button>
              {showEarlier &&
                earlier.map((c, i) => (
                  <ContextCard
                    key={c.id}
                    context={c}
                    hue={recent.length + i}
                    isActive={active?.id === c.id}
                    onSelect={() => setSelected(c.id)}
                  />
                ))}
            </>
          )}

          {result.unassigned.length > 0 && (
            <LoosePanel refs={result.unassigned} byRef={byRef} tz={tz} onInspect={setInspected} />
          )}
          {aside}
        </div>
      </section>

      <section className="col">
        <h2 className="col-head">{inspectedEvent ? t('detail.title') : t('resume.title')}</h2>
        <div className="col-body">
          {inspectedEvent ? (
            <EventDetail
              event={inspectedEvent}
              tz={tz}
              actions={actions}
              onClose={() => setInspected(null)}
            />
          ) : resume && active ? (
            <div className="card resume">
              <div className="eyebrow">{t('resume.wasWorkingOn')}</div>
              <h3>{resume.contextLabel}</h3>
              <div className="submeta">
                {t('resume.lastActivity')} {clock(resume.lastActiveAt, tz)} ·{' '}
                <b>{formatDuration(resume.activeMs)}</b> {t('resume.active')}
              </div>
              <AppChain apps={resume.appChain} />

              <Rows label={t('resume.files')} lines={resume.working} tz={tz} />
              <Rows label={t('resume.reading')} lines={resume.reading} tz={tz} />
              <Rows label={t('resume.ran')} lines={resume.ran} tz={tz} />
              <Rows label={t('resume.failed')} lines={resume.failures} tz={tz} />
              <Rows label={t('resume.produced')} lines={resume.produced} tz={tz} />

              {resume.nextStep && (
                <div className="next">
                  <div className="eyebrow">{t('resume.nextStep')}</div>
                  <p>{renderNextStep(resume.nextStep)}</p>
                </div>
              )}
              <p className="footnote">{t('resume.footnote')}</p>
            </div>
          ) : (
            <div className="card empty">{t('resume.none')}</div>
          )}

          {!inspectedEvent && active && <Anchors context={active} />}
          {!inspectedEvent && (
            <Forecast
              predictions={predictions}
              tz={tz}
              onSelect={(label) => {
                const match = result.contexts.find((c) => c.label === label);
                if (match) setSelected(match.id);
              }}
            />
          )}
        </div>
      </section>

      <section className="col">
        <h2 className="col-head">
          {t('timeline.title')} <span className="col-note">{t('timeline.newestFirst')}</span>
        </h2>
        <div className="col-body">
          {active && (
            <Timeline
              context={active}
              activities={result.activities}
              byRef={byRef}
              tz={tz}
              inspected={inspected}
              onInspect={setInspected}
            />
          )}
        </div>
      </section>
    </main>
  );
}

/**
 * Newest first, grouped by hour, with repetition collapsed.
 *
 * Chronological order buries the thing you opened the window to see. And a real day returns to the
 * same window dozens of times, so consecutive events that say the same thing become one line with a
 * count — otherwise the list is a minute-by-minute tree nobody reads.
 */
function Timeline({
  context,
  activities,
  byRef,
  tz,
  inspected,
  onInspect,
}: {
  context: EngineContext;
  activities: Activity[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
  inspected: string | null;
  onInspect: (ref: string) => void;
}) {
  const inContext = new Set(context.eventRefs);

  const blocks = useMemo(() => {
    const out = activities
      .map((a) => ({
        activity: a,
        events: a.eventRefs
          .filter((r) => inContext.has(r))
          .map((r) => byRef.get(r))
          .filter((e): e is GoldenEvent => Boolean(e))
          .sort((x, y) => y.timestamp - x.timestamp),
      }))
      .filter((b) => b.events.length > 0);
    out.sort((x, y) => y.events[0]!.timestamp - x.events[0]!.timestamp);
    return out;
  }, [activities, byRef, context.eventRefs.join(',')]);

  let lastHour = '';

  return (
    <div className="timeline">
      {blocks.map((b) => {
        const first = b.events[b.events.length - 1]!;
        const last = b.events[0]!;
        const span = (last.endTimestamp ?? last.timestamp) - first.timestamp;
        const hour = hourKey(last.timestamp, tz);
        const showHour = hour !== lastHour;
        lastHour = hour;

        return (
          <div key={b.activity.id}>
            {showHour && <div className="tl-hour">{hour}h</div>}
            <div className="tl-block">
              <div className="tl-gutter">
                <span className="tl-time">{clock(first.timestamp, tz)}</span>
                <span className="tl-rail" aria-hidden />
              </div>
              <div className="tl-body">
                <div className="tl-head">
                  {b.activity.apps.slice(0, 4).map((app) => (
                    <span className="chip" key={app}>
                      {app}
                    </span>
                  ))}
                  {span >= 60_000 && <span className="tl-span">{formatDuration(span)}</span>}
                </div>
                <ul className="tl-events">
                  {collapse(b.events).map(({ event, count }) => {
                    const src = SOURCES[event.source] ?? { glyph: '·', label: event.source };
                    return (
                      <li
                        key={event.ref}
                        className={[
                          `src-${event.source}`,
                          isFailure(event) ? 'fail' : '',
                          isWin(event) ? 'win' : '',
                          inspected === event.ref ? 'cited' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <button className="tl-row" onClick={() => onInspect(event.ref)}>
                          <span className="tl-dot" title={src.label}>
                            {src.glyph}
                          </span>
                          <span className="tl-at">{clock(event.timestamp, tz)}</span>
                          <span className="tl-text">{headline(event)}</span>
                          {count > 1 && <span className="tl-count">×{count}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Consecutive events saying the same thing become one row with a count. */
function collapse(events: GoldenEvent[]): { event: GoldenEvent; count: number }[] {
  const out: { event: GoldenEvent; count: number }[] = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.event.app === event.app &&
      headline(previous.event) === headline(event)
    ) {
      previous.count += 1;
      continue;
    }
    out.push({ event, count: 1 });
  }
  return out;
}

/** Everything known about one event, and everything it can open. */
function EventDetail({
  event,
  tz,
  actions,
  onClose,
}: {
  event: GoldenEvent;
  tz: number;
  actions?: WorkspaceActions;
  onClose: () => void;
}) {
  const m = meta(event);
  const targets = targetsOf(event);
  const src = SOURCES[event.source] ?? { glyph: '·', label: event.source };
  const duration = event.endTimestamp ? event.endTimestamp - event.timestamp : 0;

  const rows: [string, string][] = [
    [t('detail.when'), clock(event.timestamp, tz)],
    ...(duration >= 1000
      ? ([[t('detail.duration'), formatDuration(duration)]] as [string, string][])
      : []),
    [t('detail.app'), event.appDisplay ?? event.app ?? '—'],
    [t('detail.source'), src.label],
    [t('detail.kind'), event.type],
  ];

  // Only scalars, and never a payload we would not show: the detail panel must not become a way to
  // surface something the capture rules kept out.
  const extra = Object.entries(m)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .filter(([k]) => !['bundleId', 'pid'].includes(k))
    .slice(0, 14);

  return (
    <div className="card detail">
      <button className="close" onClick={onClose} aria-label="Fermer">
        ×
      </button>
      <div className="eyebrow">{src.label}</div>
      <h3>{headline(event)}</h3>
      {event.title && event.title !== headline(event) && (
        <p className="detail-title">{event.title}</p>
      )}

      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {extra.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{String(v)}</dd>
          </div>
        ))}
      </dl>

      {Array.isArray(m['tools']) && (m['tools'] as unknown[]).length > 0 && (
        <div className="rows">
          <div className="eyebrow">{t('detail.tools')}</div>
          <div className="tags">
            {(m['tools'] as string[]).map((tool) => (
              <span className="tag" key={tool}>
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}

      {targets.length > 0 && actions?.open && (
        <div className="rows">
          <div className="eyebrow">{t('detail.open')}</div>
          {targets.map((target, i) => (
            <div className="line" key={`${target.target}-${i}`}>
              <button className="link" onClick={() => actions.open?.(target.target)}>
                {target.label}
              </button>
              {target.kind !== 'url' && actions.reveal && (
                <button className="cite" onClick={() => actions.reveal?.(target.target)}>
                  {t('detail.reveal')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {event.redaction && event.redaction.count > 0 && (
        <p className="footnote">
          {t('detail.redacted')} {event.redaction.count} — {event.redaction.applied.join(', ')}
        </p>
      )}
    </div>
  );
}

/**
 * Where the work happened: repository, branch, declared project.
 *
 * Under the name, never in it. These used to BE the name — a context called "Importer.Ts" or
 * "Travail dans rewind-desktop" told you where you were and never what you were doing.
 */
function Place({ place }: { place: EngineContext['place'] }) {
  const parts = [place.project, place.repository, place.branch].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return (
    <div className="place">
      {parts.map((p, i) => (
        <span key={p}>
          {i > 0 && <span className="sep">·</span>}
          <span className="mono">{p}</span>
        </span>
      ))}
    </div>
  );
}

export function AppChain({ apps }: { apps: string[] }) {
  const shown = apps.slice(0, 6);
  return (
    <div className="chain">
      {shown.map((a, i) => (
        <span className="chain-item" key={a}>
          <span className="chip solid">{a}</span>
          {i < shown.length - 1 && <span className="sep">→</span>}
        </span>
      ))}
      {apps.length > shown.length && <span className="sep">+{apps.length - shown.length}</span>}
    </div>
  );
}

function ContextCard({
  context,
  hue,
  isActive,
  onSelect,
}: {
  context: EngineContext;
  hue: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`card ctx hue-${hue % 5} ${isActive ? 'on' : ''}`} onClick={onSelect}>
      <span className="ctx-bar" aria-hidden />
      <div className="ctx-top">
        <span className="ctx-label">
          {context.labelIsFallback ? `${t('today.fallbackLabel')} ${context.label}` : context.label}
        </span>
        <span className="ctx-dur">{formatDuration(context.activeMs)}</span>
      </div>
      <Place place={context.place} />
      <AppChain apps={context.appChain} />
      <div className="ctx-foot">
        {context.eventRefs.length} {t('header.events')} · {t('today.confidence')}{' '}
        {Math.round(context.confidence * 100)}%
      </div>
    </button>
  );
}

function Rows({
  label,
  lines,
  tz,
}: {
  label: string;
  lines: { label: string; detail?: string; timestamp: number; tone?: string }[];
  tz: number;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="rows">
      <div className="eyebrow">{label}</div>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.tone ?? ''}`}>
          <span className="mono">{l.label}</span>
          {l.detail && <span className="detail">{l.detail}</span>}
          <span className="at">{clock(l.timestamp, tz)}</span>
        </div>
      ))}
    </div>
  );
}

function Anchors({ context }: { context: EngineContext }) {
  const sorted = [...context.anchors].sort((a, b) => b.confidence - a.confidence).slice(0, 12);
  if (sorted.length === 0) return null;
  return (
    <div className="card anchors">
      <div className="eyebrow">{t('anchors.title')}</div>
      <div className="tags">
        {sorted.map((a, i) => (
          <span key={i} className={`tag ${strength(a.type)}`} title={`${a.type} · ${a.source}`}>
            <em>{a.type}</em>
            {a.value}
          </span>
        ))}
      </div>
    </div>
  );
}

function LoosePanel({
  refs,
  byRef,
  tz,
  onInspect,
}: {
  refs: string[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
  onInspect: (ref: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const events = refs
    .map((r) => byRef.get(r))
    .filter((e): e is GoldenEvent => Boolean(e))
    .sort((a, b) => b.timestamp - a.timestamp);
  if (events.length === 0) return null;

  // Collapsed by default now that a real day produces hundreds. Still reachable in one click —
  // nothing captured may be invisible, but "visible" does not have to mean "always expanded".
  return (
    <div className="card loose">
      <button className="disclosure flush" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {t('today.loose')} · {events.length}
      </button>
      {open && (
        <>
          <ul className="loose-list">
            {collapse(events)
              .slice(0, 60)
              .map(({ event, count }) => (
                <li key={event.ref} className={`src-${event.source}`}>
                  <button className="tl-row" onClick={() => onInspect(event.ref)}>
                    <span className="tl-dot">
                      {(SOURCES[event.source] ?? { glyph: '·' }).glyph}
                    </span>
                    <span className="tl-at">{clock(event.timestamp, tz)}</span>
                    <span className="tl-text">{headline(event)}</span>
                    {count > 1 && <span className="tl-count">×{count}</span>}
                  </button>
                </li>
              ))}
          </ul>
          <p className="footnote">{t('today.looseHint')}</p>
        </>
      )}
    </div>
  );
}

/** The engine returns which rule fired and its values; the wording lives here (§147). */
function renderNextStep(step: NextStep): string {
  switch (step.rule) {
    case 'quote_note':
      return step.text; // The user's own words, verbatim and never translated.
    case 'fix_failing_command':
      return `${t('next.fixFailing')} ${step.command}`;
    case 'commit_or_stash':
      return [
        t('next.commitOrStash'),
        step.count,
        tPlural('next.files', step.count),
        step.branch ? `${t('next.onBranch')} ${step.branch}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'review_agent_work':
      return t('next.reviewAgent');
  }
}
