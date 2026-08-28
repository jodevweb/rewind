/**
 * REWIND — the desktop window.
 *
 * The same interface the studio renders, on real events from the daemon. It was a bare event list
 * for one commit while the real interface lived only in the studio; that gap is closed.
 *
 * There is no start button and there will not be one. Capture runs from launch and you pause it
 * (§7, §84).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import type { GoldenSession } from '@rewind/fixtures/authoring';
import { getLocale, setLocale, t, tPlural, Workspace, type Locale } from '@rewind/ui';
import { runEngine } from '@rewind/engine-v0';
import '@rewind/ui/styles.css';

interface CaptureStatus {
  recording: boolean;
  pausedUntil: number | null;
  eventsToday: number;
  titleAccess: 'granted' | 'denied' | 'not_required';
  platform: 'macos' | 'windows' | 'other';
}

interface DaemonEvent {
  timestamp: number;
  endTimestamp: number | null;
  appId: string;
  appDisplay: string;
  title: string;
  pid: number | null;
}

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

const PAUSES = [
  { label: '5 min', minutes: 5 },
  { label: '30 min', minutes: 30 },
  { label: '1 h', minutes: 60 },
  { label: "Jusqu'à reprise", minutes: 0 },
];

/**
 * Adapt the daemon's focus events into the session shape the engine consumes.
 *
 * The daemon speaks a narrow struct; the engine speaks the event model. Converting here rather than
 * widening either keeps the daemon small and the engine platform-agnostic — and it is the seam the
 * Rust port replaces, since the engine will eventually consume these events directly.
 */
function toSession(events: DaemonEvent[]): GoldenSession {
  const tz = -new Date().getTimezoneOffset();
  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  return {
    id: 'live',
    name: 'Aujourd’hui',
    description: 'Activité capturée sur cette machine.',
    tests: '',
    day: new Date().toISOString().slice(0, 10),
    tzOffsetMinutes: tz,
    expected: { contextCount: 0, contexts: [], noiseEventRefs: [] },
    events: ordered.map((e, i) => ({
      id: `live-${i}`,
      ref: `live-${String(i).padStart(5, '0')}`,
      timestamp: e.timestamp,
      ...(e.endTimestamp !== null ? { endTimestamp: e.endTimestamp } : {}),
      tzOffsetMinutes: tz,
      source: 'system' as const,
      type: 'system.window.focus',
      producer: { name: 'rewind-daemon', version: '0.1.0' },
      app: e.appId,
      appDisplay: e.appDisplay,
      title: e.title,
      metadata: { bundleId: e.appId, ...(e.pid !== null ? { pid: e.pid } : {}) },
      privacyLevel: 'normal' as const,
      redaction: { patternsVersion: '1.0.1', applied: [], count: 0 },
      importance: 30,
    })),
  };
}

export function App() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        invoke<CaptureStatus>('capture_status'),
        invoke<DaemonEvent[]>('recent_events', { limit: 400 }),
      ]);
      setStatus(s);
      setEvents(e);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const session = useMemo(() => toSession(events), [events]);
  const contextCount = useMemo(
    () => (session.events.length > 0 ? runEngine(session).contexts.length : 0),
    [session],
  );

  const setPaused = async (minutes: number | null) => {
    setStatus(await invoke<CaptureStatus>('set_paused', { minutes }));
  };

  const switchLocale = (next: Locale) => {
    setLocale(next);
    forceRender((n) => n + 1);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className={`pulse ${status?.recording ? '' : 'paused'}`} aria-hidden />
          <span className="wordmark">REWIND</span>
          <span className="sub">
            {status?.recording
              ? t('app.recording')
              : status?.pausedUntil
                ? `${t('app.pausedUntil')} ${clock(status.pausedUntil)}`
                : t('app.paused')}
          </span>
        </div>

        <div className="pauses">
          {status?.recording ? (
            PAUSES.map((p) => (
              <button key={p.minutes} onClick={() => void setPaused(p.minutes)}>
                {p.label}
              </button>
            ))
          ) : (
            <button className="primary" onClick={() => void setPaused(null)}>
              {t('app.resume')}
            </button>
          )}
        </div>

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

      {/* macOS cannot read window titles without Accessibility, and the titles are most of the
          signal. Say so rather than pretending the capture is as good (ADR 0003 D-22). */}
      {status?.titleAccess === 'denied' && (
        <div className="banner warn">
          <strong>{t('perm.title')}</strong> {t('perm.body')}
        </div>
      )}

      {error && <div className="banner warn">{error}</div>}

      <Workspace session={session} emptyMessage={t('app.empty')} />
    </div>
  );
}
