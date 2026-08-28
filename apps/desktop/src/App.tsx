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
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

import type { GoldenSession } from '@rewind/fixtures/authoring';
import {
  getLocale,
  setLocale,
  t,
  tPlural,
  Workspace,
  type Locale,
  type WorkspaceActions,
} from '@rewind/ui';
import { runEngine } from '@rewind/engine-v0';
import '@rewind/ui/styles.css';

interface CaptureStatus {
  recording: boolean;
  pausedUntil: number | null;
  eventsToday: number;
  eventsTotal: number;
  titleAccess: 'granted' | 'denied' | 'not_required';
  platform: 'macos' | 'windows' | 'other';
  /** Where the events actually live. Shown so it is never a mystery (PRIVACY §12). */
  storePath: string;
  diagnostics: string;
}

interface DaemonEvent {
  timestamp: number;
  endTimestamp: number | null;
  tzOffsetMinutes: number;
  source: string;
  type: string;
  appId: string;
  appDisplay: string;
  title: string;
  pid: number | null;
  /** JSON. Opaque to the daemon, meaningful to the engine — anchors live in here. */
  metadata: string;
  redactionVersion: string;
  redactionApplied: string[];
  redactionCount: number;
  importance: number;
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
function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

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
      source: e.source as 'system',
      type: e.type,
      producer: { name: 'rewind-daemon', version: '0.1.0' },
      app: e.appId,
      appDisplay: e.appDisplay,
      title: e.title,
      metadata: {
        bundleId: e.appId,
        ...(e.pid !== null ? { pid: e.pid } : {}),
        // The daemon keeps the payload opaque; parsing it here is what turns a Claude session into
        // anchors the engine can group on. A malformed payload must not take the timeline with it.
        ...parseMetadata(e.metadata),
      },
      privacyLevel: 'normal' as const,
      redaction: {
        patternsVersion: e.redactionVersion,
        applied: e.redactionApplied,
        count: e.redactionCount,
      },
      importance: e.importance,
    })),
  };
}

export function App() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [events, setEvents] = useState<DaemonEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        invoke<CaptureStatus>('capture_status'),
        invoke<DaemonEvent[]>('recent_events', { limit: 5000 }),
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

  // Check for an update on launch, then hourly. Offered, never applied on its own: an application
  // that restarts itself while you are working is a worse problem than a stale version.
  useEffect(() => {
    const look = () =>
      checkForUpdate()
        .then((found) => setUpdate(found ?? null))
        .catch(() => {
          // No network, no release yet, or a signature that does not verify. None of those are
          // worth interrupting anyone over.
        });
    void look();
    const timer = setInterval(() => void look(), 3_600_000);
    return () => clearInterval(timer);
  }, []);

  const applyUpdate = async () => {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setUpdating(false);
    }
  };

  const session = useMemo(() => toSession(events), [events]);
  const contextCount = useMemo(
    () => (session.events.length > 0 ? runEngine(session).contexts.length : 0),
    [session],
  );

  // Opening is what makes the interface an explorer rather than a log. The daemon does the opening:
  // it is the only side that can check the target is a real path or an http(s) URL before handing it
  // to the system, and it never goes through a shell.
  const actions: WorkspaceActions = useMemo(
    () => ({
      open: (target) => void invoke('open_target', { target }).catch(setError),
      reveal: (target) => void invoke('reveal_target', { target }).catch(setError),
    }),
    [],
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

        <div className="stat" title={status?.storePath ?? ''}>
          <b>{session.events.length}</b> {t('header.events')}
          <span className="arrow">→</span>
          <b>{contextCount}</b> {tPlural('header.contexts', contextCount)}
          {status && status.eventsTotal > status.eventsToday && (
            <span className="total">
              · {status.eventsTotal} {t('header.kept')}
            </span>
          )}
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

      {update && (
        <div className="banner update">
          <strong>
            {t('update.available')} {update.version}
          </strong>{' '}
          {(update.body ?? '').split(/\r?\n/)[0]}
          <button className="ghost" disabled={updating} onClick={() => void applyUpdate()}>
            {updating ? t('update.installing') : t('update.install')}
          </button>
        </div>
      )}

      {error && <div className="banner warn">{error}</div>}

      <Workspace session={session} emptyMessage={t('app.empty')} actions={actions} />

      {status && (
        <footer className="diag">
          <span>{status.platform}</span>
          <span>·</span>
          <span>
            {t('diag.titles')} {t(`diag.${status.titleAccess}` as 'diag.granted')}
          </span>
          {status.diagnostics && (
            <>
              <span>·</span>
              <span className="mono">{status.diagnostics}</span>
            </>
          )}
          <span>·</span>
          <span className="mono" title={status.storePath}>
            {status.eventsTotal} {t('header.kept')}
          </span>
        </footer>
      )}
    </div>
  );
}
