/**
 * REWIND Studio — the Fake Collector's surface (ticket P1-007, ADR 0002 D-9).
 *
 * A development tool, not the product: it replays golden sessions through the engine and shows the
 * result next to the ground truth. The product is the desktop application.
 *
 * The interface itself now lives in `@rewind/ui` and is the same one the application renders. It was
 * duplicated for a while, which is how the application ended up looking nothing like the thing being
 * designed — there were two interfaces and only one of them was the product.
 */

import { useEffect, useMemo, useState } from 'react';

import { ALL_SESSIONS } from '@rewind/fixtures/sessions';
import type { GoldenSession } from '@rewind/fixtures/authoring';
import { getLocale, setLocale, t, tPlural, Workspace, type Locale } from '@rewind/ui';
import { runEngine } from '@rewind/engine-v0';
import '@rewind/ui/styles.css';

const CAPTURED_ID = 'captured-session';

export function App() {
  const [sessionId, setSessionId] = useState(ALL_SESSIONS[6]!.id);
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
  const contextCount = useMemo(() => runEngine(session).contexts.length, [session]);
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
          onChange={(e) => setSessionId(e.target.value)}
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
          <b>{contextCount}</b> {tPlural('header.contexts', contextCount)}
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

      <Workspace session={session} aside={<TruthPanel session={session} found={contextCount} />} />
    </div>
  );
}

/** Studio-only: the fixture's declared ground truth, so the engine can be read against it. */
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
