/**
 * REWIND Studio — the Fake Collector's surface (ticket P1-007, ADR 0002 D-9).
 *
 * The first milestone made visible: golden session → events → contexts → Resume, with citations, no
 * Rust and no LLM. Every figure on screen is computed from events by @rewind/engine-v0.
 *
 * This is the development and demo surface, not the product UI. The product is a Tauri desktop app
 * with a tray icon and continuous capture; a web page can never be it, because controlling capture
 * from a browser would need the localhost HTTP server ADR 0001 D-5 forbids.
 */

import { useEffect, useMemo, useState } from 'react';

import { ALL_SESSIONS } from '@rewind/fixtures/sessions';
import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import {
  buildResume,
  runEngine,
  strength,
  type Activity,
  type EngineContext,
} from '@rewind/engine-v0';

import { formatDuration, getLocale, setLocale, t, tPlural, type Locale } from './i18n.js';
import type { NextStep } from '@rewind/engine-v0';

const CAPTURED_ID = 'captured-session';

const clock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

/**
 * Source identity as restrained colour. §143 preferred monochrome glyphs, but over a dense timeline
 * a single accent proved genuinely hard to scan. Each source gets one muted hue — muted being the
 * operative word, since this must not turn into a rainbow dashboard (§142).
 */
const SOURCES: Record<string, { glyph: string; label: string }> = {
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

function headline(e: GoldenEvent): string {
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
    case 'agent.session.started':
      return 'session Claude Code démarrée';
    case 'agent.activity':
      return `Claude Code — ${m['toolCallCount'] ?? 0} appels d’outils`;
    case 'external.mission.started':
      return `mission : ${str(e, 'mission') ?? ''}`;
    case 'external.run.finished':
      return `run ${str(e, 'runId') ?? ''} — ${str(e, 'status') ?? ''}`;
    case 'external.agent.started':
      return `agent ${str(e, 'agent') ?? ''} démarré`;
    case 'system.window.title_changed':
      return e.title ?? '';
    default:
      return e.title ?? e.type;
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

export function App() {
  const [sessionId, setSessionId] = useState(ALL_SESSIONS[6]!.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [citation, setCitation] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const [captured, setCaptured] = useState<GoldenSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch('/captured/session.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s: GoldenSession | null) => {
          if (!cancelled && s && s.events.length > 0) setCaptured(s);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const allSessions = useMemo(
    () => (captured ? [captured, ...ALL_SESSIONS] : ALL_SESSIONS),
    [captured],
  );
  const session = useMemo(
    () => (allSessions.find((s) => s.id === sessionId) ?? allSessions[0]) as GoldenSession,
    [allSessions, sessionId],
  );
  const result = useMemo(() => runEngine(session), [session]);
  const byRef = useMemo(() => new Map(session.events.map((e) => [e.ref, e])), [session]);

  const active = result.contexts.find((c) => c.id === selected) ?? result.contexts[0];
  const resume = useMemo(() => (active ? buildResume(session, active) : null), [session, active]);
  const isCaptured = session.id === CAPTURED_ID;

  const switchLocale = (next: Locale) => {
    setLocale(next);
    forceRender((n) => n + 1);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="pulse" aria-hidden />
          <span className="wordmark">REWIND</span>
          <span className="sub">{t('app.subtitle')}</span>
        </div>

        <select
          className="picker"
          value={session.id}
          onChange={(e) => {
            setSessionId(e.target.value);
            setSelected(null);
          }}
        >
          {allSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === CAPTURED_ID ? '● ' : ''}
              {s.name} — {s.events.length} {t('header.events')}
            </option>
          ))}
        </select>

        <span className={`badge ${isCaptured ? 'live' : 'fixture'}`}>
          {isCaptured ? t('badge.real') : t('badge.fixture')}
        </span>

        <div className="spacer" />

        <div className="stat">
          <b>{session.events.length}</b> {t('header.events')}
          <span className="arrow">→</span>
          <b>{result.contexts.length}</b> {tPlural('header.contexts', result.contexts.length)}
        </div>

        <div className="locale">
          {(['fr', 'en'] as Locale[]).map((l) => (
            <button
              key={l}
              className={getLocale() === l ? 'on' : ''}
              onClick={() => switchLocale(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {!captured && (
        <div className="banner">
          <strong>{t('banner.title')}</strong> {t('banner.body')} <code>pnpm capture</code>{' '}
          {t('banner.body2')}
        </div>
      )}

      <main>
        <section className="col">
          <h2>{t('today.title')}</h2>
          <p className="hint">{t('today.hint')}</p>
          {result.contexts.map((c, i) => (
            <ContextCard
              key={c.id}
              context={c}
              hue={i}
              isActive={active?.id === c.id}
              onSelect={() => setSelected(c.id)}
            />
          ))}
          {result.unassigned.length > 0 && (
            <LoosePanel refs={result.unassigned} byRef={byRef} tz={session.tzOffsetMinutes} />
          )}
          <TruthPanel session={session} found={result.contexts.length} />
        </section>

        <section className="col">
          <h2>{t('resume.title')}</h2>
          {resume && active ? (
            <div className="card resume">
              <div className="eyebrow">{t('resume.wasWorkingOn')}</div>
              <h3>{resume.contextLabel}</h3>
              <div className="submeta">
                {t('resume.lastActivity')} {clock(resume.lastActiveAt, session.tzOffsetMinutes)} ·{' '}
                <b>{formatDuration(resume.activeMs)}</b> {t('resume.active')}
              </div>
              <AppChain apps={resume.appChain} />

              <Rows
                label={t('resume.files')}
                lines={resume.working}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label={t('resume.reading')}
                lines={resume.reading}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label={t('resume.ran')}
                lines={resume.ran}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label={t('resume.failed')}
                lines={resume.failures}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label={t('resume.produced')}
                lines={resume.produced}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />

              {resume.nextStep && (
                <div className="next">
                  <div className="eyebrow">{t('resume.nextStep')}</div>
                  <p>{renderNextStep(resume.nextStep)}</p>
                  <button
                    className="cite"
                    onClick={() => setCitation(resume.nextStep!.evidenceRef)}
                  >
                    {t('resume.evidence')}
                  </button>
                </div>
              )}

              <div className="actions">
                {resume.openResources.slice(0, 4).map((r, i) => (
                  <button key={i} className="ghost" title={r.target}>
                    {t('resume.open')} {t(`openKind.${r.kind}` as 'openKind.url')}
                  </button>
                ))}
              </div>
              <p className="footnote">{t('resume.footnote')}</p>
            </div>
          ) : (
            <div className="card empty">{t('resume.none')}</div>
          )}

          {active && <Anchors context={active} />}
        </section>

        <section className="col">
          <h2>{t('timeline.title')}</h2>
          {active && (
            <Timeline
              context={active}
              activities={result.activities}
              byRef={byRef}
              tz={session.tzOffsetMinutes}
              citation={citation}
            />
          )}
        </section>
      </main>
    </div>
  );
}

/*
 * Timeline — rewritten.
 *
 * The previous version nested a column flexbox inside a baseline-aligned row, which pushed the
 * application label out to the right and stretched every row to about 90 pixels. It also rendered
 * raw events, so a session read as an undifferentiated log rather than as work.
 *
 * Now events are grouped into the activities the engine actually produced, on a continuous rail —
 * the structure the product's timeline is specified to have (§50): grouped, not raw.
 */
function Timeline({
  context,
  activities,
  byRef,
  tz,
  citation,
}: {
  context: EngineContext;
  activities: Activity[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
  citation: string | null;
}) {
  const inContext = new Set(context.eventRefs);
  const blocks = activities
    .map((a) => ({
      activity: a,
      events: a.eventRefs
        .filter((r) => inContext.has(r))
        .map((r) => byRef.get(r))
        .filter((e): e is GoldenEvent => Boolean(e))
        .sort((x, y) => x.timestamp - y.timestamp),
    }))
    .filter((b) => b.events.length > 0)
    .sort((x, y) => x.events[0]!.timestamp - y.events[0]!.timestamp);

  return (
    <div className="timeline">
      {blocks.map((b) => {
        const first = b.events[0]!;
        const last = b.events[b.events.length - 1]!;
        const span = (last.endTimestamp ?? last.timestamp) - first.timestamp;
        return (
          <div className="tl-block" key={b.activity.id}>
            <div className="tl-gutter">
              <span className="tl-time">{clock(first.timestamp, tz)}</span>
              <span className="tl-rail" aria-hidden />
            </div>
            <div className="tl-body">
              <div className="tl-head">
                {b.activity.apps.map((app) => (
                  <span className="chip" key={app}>
                    {app}
                  </span>
                ))}
                {span >= 60_000 && <span className="tl-span">{formatDuration(span)}</span>}
              </div>
              <ul className="tl-events">
                {b.events.map((e) => {
                  const src = SOURCES[e.source] ?? { glyph: '·', label: e.source };
                  return (
                    <li
                      key={e.ref}
                      className={[
                        `src-${e.source}`,
                        isFailure(e) ? 'fail' : '',
                        isWin(e) ? 'win' : '',
                        citation === e.ref ? 'cited' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span className="tl-dot" title={src.label}>
                        {src.glyph}
                      </span>
                      <span className="tl-at">{clock(e.timestamp, tz)}</span>
                      <span className="tl-text">{headline(e)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The engine returns which rule fired and with what values, never a sentence — so the wording lives
 * here, where it can be translated (§147).
 */
function renderNextStep(step: NextStep): string {
  switch (step.rule) {
    case 'quote_note':
      return step.text; // The user's own words, quoted verbatim and never translated.
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

/**
 * Events the engine attached to nothing.
 *
 * These used to be a single-line count, which made a captured event look deleted: it was in the
 * file, it just was not on screen anywhere. Nothing captured may be invisible.
 */
function LoosePanel({
  refs,
  byRef,
  tz,
}: {
  refs: string[];
  byRef: Map<string, GoldenEvent>;
  tz: number;
}) {
  const events = refs
    .map((r) => byRef.get(r))
    .filter((e): e is GoldenEvent => Boolean(e))
    .sort((a, b) => a.timestamp - b.timestamp);
  if (events.length === 0) return null;

  return (
    <div className="card loose">
      <div className="eyebrow">
        {t('today.loose')} · {events.length}
      </div>
      <ul className="loose-list">
        {events.map((e) => {
          const src = SOURCES[e.source] ?? { glyph: '·', label: e.source };
          return (
            <li key={e.ref} className={`src-${e.source}`}>
              <span className="tl-dot">{src.glyph}</span>
              <span className="tl-at">{clock(e.timestamp, tz)}</span>
              <span className="tl-text">{headline(e)}</span>
            </li>
          );
        })}
      </ul>
      <p className="footnote">{t('today.looseHint')}</p>
    </div>
  );
}

function AppChain({ apps }: { apps: string[] }) {
  return (
    <div className="chain">
      {apps.map((a, i) => (
        <span className="chain-item" key={a}>
          <span className="chip solid">{a}</span>
          {i < apps.length - 1 && <span className="sep">→</span>}
        </span>
      ))}
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
  onCite,
}: {
  label: string;
  lines: {
    label: string;
    detail?: string;
    evidenceRef: string;
    timestamp: number;
    tone?: string;
  }[];
  tz: number;
  onCite: (ref: string) => void;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="rows">
      <div className="eyebrow">{label}</div>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.tone ?? ''}`}>
          <span className="mono">{l.label}</span>
          {l.detail && <span className="detail">{l.detail}</span>}
          <button className="cite" onClick={() => onCite(l.evidenceRef)}>
            {clock(l.timestamp, tz)}
          </button>
        </div>
      ))}
    </div>
  );
}

function Anchors({ context }: { context: EngineContext }) {
  const sorted = [...context.anchors].sort((a, b) => b.confidence - a.confidence).slice(0, 14);
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

function TruthPanel({ session, found }: { session: GoldenSession; found: number }) {
  if (session.expected.contexts.length === 0) {
    return (
      <div className="card truth">
        <div className="eyebrow">{t('truth.real')}</div>
        <p className="truth-body">{t('truth.realBody')}</p>
      </div>
    );
  }
  const ok = found === session.expected.contextCount;
  return (
    <div className="card truth">
      <div className="eyebrow">{t('truth.fixture')}</div>
      {session.expected.contexts.map((c) => (
        <div className="truth-line" key={c.tag}>
          <span>{c.label}</span>
          <span className="detail">
            {c.eventRefs.length} {t('header.events')}
          </span>
        </div>
      ))}
      <div className={`verdict ${ok ? 'ok' : 'off'}`}>
        {t('truth.found')} {found} · {t('truth.expected')} {session.expected.contextCount}
      </div>
    </div>
  );
}
