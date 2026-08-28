/**
 * REWIND Studio — the Fake Collector's surface (ticket P1-007, ADR 0002 D-9).
 *
 * This is the first milestone made visible: **golden session → events → contexts → Resume**, with
 * citations, with no Rust, no collectors and no LLM. Every number and every line on screen is
 * computed from the fixture events by @rewind/engine-v0.
 *
 * It is not the product UI. It is the development and demo surface that stays in the repository
 * permanently, for tests, demos, debugging and reproducing issues.
 */

import { useEffect, useMemo, useState } from 'react';

// The package root pulls in Node-only loaders; the studio takes the pure-data entry points.
import { ALL_SESSIONS } from '@rewind/fixtures/sessions';
import type { GoldenEvent, GoldenSession } from '@rewind/fixtures/authoring';
import { appName, buildResume, runEngine, strength, type EngineContext } from '@rewind/engine-v0';

const fmtClock = (ts: number, tz: number) => new Date(ts + tz * 60_000).toISOString().slice(11, 16);

const fmtDuration = (ms: number) => {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
};

const SOURCE_GLYPH: Record<string, string> = {
  system: '▢',
  browser: '◍',
  ide: '◆',
  filesystem: '▤',
  git: '◈',
  terminal: '▸',
  agent: '✳',
  external: '⬢',
  manual: '✎',
};

function eventHeadline(e: GoldenEvent): string {
  const m = e.metadata as Record<string, unknown>;
  const s = (k: string) => (typeof m[k] === 'string' ? (m[k] as string) : undefined);
  switch (e.type) {
    case 'terminal.command':
      return s('commandRedacted') ?? 'command';
    case 'terminal.error_tail':
      return Array.isArray(m['lines']) ? String((m['lines'] as unknown[])[0]) : 'error';
    case 'git.commit':
      return s('messageRedacted') ?? 'commit';
    case 'git.branch.checkout':
      return `checkout ${s('to') ?? ''}`;
    case 'git.status.summary':
      return `${m['dirtyFiles'] ?? 0} uncommitted file(s) on ${s('branch') ?? ''}`;
    case 'manual.note':
      return s('text') ?? '';
    case 'browser.navigation':
    case 'browser.tab.activated':
      return e.title ?? s('url') ?? 'page';
    case 'ide.file.saved':
    case 'ide.file.opened':
      return (s('path') ?? '').split(/[/\\]/).pop() ?? 'file';
    case 'agent.session.started':
      return `Claude Code session started`;
    case 'agent.activity':
      return `Claude Code — ${m['toolCallCount'] ?? 0} tool calls`;
    case 'external.mission.started':
      return `Cockpit mission: ${s('mission') ?? ''}`;
    case 'external.run.finished':
      return `Cockpit run ${s('runId') ?? ''} — ${s('status') ?? ''}`;
    default:
      return e.title ?? e.type;
  }
}

function isFailure(e: GoldenEvent): boolean {
  const m = e.metadata as Record<string, unknown>;
  return (
    (e.type === 'terminal.command' && m['exitCode'] !== 0) ||
    e.type === 'terminal.error_tail' ||
    e.type === 'ide.diagnostic.error'
  );
}

const CAPTURED_ID = 'captured-session';

export function App() {
  const [sessionId, setSessionId] = useState(ALL_SESSIONS[6]!.id);
  // Real activity captured on this machine by the capture probe. Written to the studio's public
  // directory, never committed, and absent until `pnpm capture` has run.
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
    // Poll while capturing so the screen fills as the machine is used.
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
  const [selected, setSelected] = useState<string | null>(null);
  const [citation, setCitation] = useState<string | null>(null);

  const session = useMemo(
    () => (allSessions.find((s) => s.id === sessionId) ?? allSessions[0]) as GoldenSession,
    [allSessions, sessionId],
  );
  const result = useMemo(() => runEngine(session), [session]);
  const byRef = useMemo(() => new Map(session.events.map((e) => [e.ref, e])), [session]);

  const active = result.contexts.find((c) => c.id === selected) ?? result.contexts[0] ?? undefined;
  const resume = useMemo(() => (active ? buildResume(session, active) : null), [session, active]);

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="dot" /> REWIND <span className="muted">Studio</span>
        </div>
        <select
          value={sessionId}
          onChange={(e) => {
            setSessionId(e.target.value);
            setSelected(null);
          }}
        >
          {allSessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === CAPTURED_ID ? '● ' : ''}
              {s.name} — {s.events.length} events
            </option>
          ))}
        </select>
        <div className="muted small">
          Fake Collector replay · {session.events.length} events → {result.contexts.length} context
          {result.contexts.length === 1 ? '' : 's'} · deterministic, no LLM
        </div>
      </header>

      <main>
        <section className="col today">
          <h2>Today</h2>
          <p className="muted small hint">
            Contexts, not applications. Durations exclude idle time and never appear per
            application.
          </p>
          {result.contexts.map((c) => (
            <ContextCard
              key={c.id}
              context={c}
              isActive={active?.id === c.id}
              onSelect={() => setSelected(c.id)}
            />
          ))}
          {result.unassigned.length > 0 && (
            <div className="noise">
              {result.unassigned.length} event{result.unassigned.length === 1 ? '' : 's'} left
              unassigned — interruptions and noise the engine declined to attach.
            </div>
          )}
          <TruthPanel session={session} result={result} />
        </section>

        <section className="col resume">
          <h2>Resume</h2>
          {resume && active ? (
            <div className="card resume-card">
              <div className="muted small">You were working on</div>
              <h3>{resume.contextLabel}</h3>
              <div className="muted small">
                Last activity {fmtClock(resume.lastActiveAt, session.tzOffsetMinutes)} ·{' '}
                {fmtDuration(resume.activeMs)} active
              </div>
              <div className="chain">{resume.appChain.join(' → ')}</div>

              <Rows
                label="Files"
                lines={resume.working}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label="Reading"
                lines={resume.reading}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label="Ran"
                lines={resume.ran}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label="Failed"
                lines={resume.failures}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />
              <Rows
                label="Produced"
                lines={resume.produced}
                tz={session.tzOffsetMinutes}
                onCite={setCitation}
              />

              {resume.nextStep && (
                <div className="next">
                  <div className="muted small">Suggested next step</div>
                  <div>{resume.nextStep.text}</div>
                  <button
                    className="cite"
                    onClick={() => setCitation(resume.nextStep!.evidenceRef)}
                  >
                    evidence
                  </button>
                </div>
              )}

              <div className="open">
                {resume.openResources.slice(0, 4).map((r, i) => (
                  <button key={i} className="ghost" title={r.target}>
                    Open {r.kind}
                  </button>
                ))}
              </div>
              <p className="muted small footnote">
                Every line above is read from stored events. Nothing here is generated.
              </p>
            </div>
          ) : (
            <div className="muted">No context detected in this session.</div>
          )}

          {active && <Anchors context={active} />}
        </section>

        <section className="col timeline">
          <h2>Timeline</h2>
          {active && (
            <ol className="events">
              {active.eventRefs
                .map((r) => byRef.get(r)!)
                .filter(Boolean)
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((e) => (
                  <li
                    key={e.ref}
                    className={`${isFailure(e) ? 'fail' : ''} ${citation === e.ref ? 'cited' : ''}`}
                  >
                    <span className="t">{fmtClock(e.timestamp, session.tzOffsetMinutes)}</span>
                    <span className="g">{SOURCE_GLYPH[e.source] ?? '·'}</span>
                    <span className="body">
                      <span className="app">{appName(e)}</span>
                      <span className="head">{eventHeadline(e)}</span>
                    </span>
                  </li>
                ))}
            </ol>
          )}
        </section>
      </main>
    </div>
  );
}

function ContextCard({
  context,
  isActive,
  onSelect,
}: {
  context: EngineContext;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`card ctx ${isActive ? 'on' : ''}`} onClick={onSelect}>
      <div className="row">
        <span className="label">{context.label}</span>
        <span className="dur">{fmtDuration(context.activeMs)}</span>
      </div>
      <div className="chain">{context.appChain.join(' → ')}</div>
      <div className="muted small">
        {context.eventRefs.length} events · confidence {Math.round(context.confidence * 100)}%
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
      <div className="muted small">{label}</div>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.tone ?? ''}`}>
          <span className="mono">{l.label}</span>
          {l.detail && <span className="muted small"> {l.detail}</span>}
          <button className="cite" onClick={() => onCite(l.evidenceRef)}>
            {fmtClock(l.timestamp, tz)}
          </button>
        </div>
      ))}
    </div>
  );
}

function Anchors({ context }: { context: EngineContext }) {
  const sorted = [...context.anchors].sort((a, b) => b.confidence - a.confidence).slice(0, 12);
  return (
    <div className="card anchors">
      <div className="muted small">
        Anchors — why these events were grouped. The application is never the reason.
      </div>
      <div className="tags">
        {sorted.map((a, i) => (
          <span key={i} className={`tag ${strength(a.type)}`} title={`${a.type} · ${a.source}`}>
            {a.type}: {a.value}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Ground truth from the fixture, so the screen can be read against what should have happened. */
function TruthPanel({
  session,
  result,
}: {
  session: GoldenSession;
  result: ReturnType<typeof runEngine>;
}) {
  if (session.expected.contexts.length === 0) {
    return (
      <div className="card truth">
        <div className="muted small">Real capture — no ground truth</div>
        <p className="small" style={{ margin: '6px 0 0' }}>
          Nobody labelled this session, so there is nothing to score against. Judge it the way you
          would judge your own memory of the day: are these the pieces of work you actually did?
        </p>
      </div>
    );
  }

  return (
    <div className="card truth">
      <div className="muted small">Ground truth (fixture)</div>
      {session.expected.contexts.map((c) => (
        <div key={c.tag} className="line">
          <span>{c.label}</span>
          <span className="muted small"> {c.eventRefs.length} events</span>
        </div>
      ))}
      <div
        className={`verdict ${result.contexts.length === session.expected.contextCount ? 'ok' : 'off'}`}
      >
        engine found {result.contexts.length} · expected {session.expected.contextCount}
      </div>
    </div>
  );
}
